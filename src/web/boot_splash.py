"""
VibeNode Boot Splash -- Ultra-Premium Edition
================================================
Full canvas-rendered 60fps animated boot splash with floating particles,
glowing progress bar with shimmer sweep, breathing title glow, completion
ring bursts, animated gradient border, vertical timeline, percentage
counter with ETA, and smooth eased transitions on everything.

Launched as a subprocess by session_manager.py.  Communicates via a status
file that run.py writes to.  Exits automatically when boot completes.

Usage:  pythonw boot_splash.py <status_file_path>
"""
import sys
import os
import math
import time
import random

# Backstop: never let a native Tk/Tcl abort raise a Windows crash dialog.
# The splash is cosmetic and runs as a child process — if Tk ever panics we
# want it to die silently, not pop a "pythonw.exe stopped working" box at the
# user.  SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX = 0x0001 | 0x0002.
if sys.platform == "win32":
    try:
        import ctypes as _ctypes
        _ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002)
    except Exception:
        pass

try:
    import tkinter as tk
except ImportError:
    sys.exit(0)

try:
    from PIL import Image, ImageTk
    _has_pil = True
except ImportError:
    _has_pil = False

# ── Configuration ─────────────────────────────────────────────────────
# The ring design: the logo inside a ring that fills as the app starts.
RING_CX, RING_CY, RING_R = 180, 153, 68    # window is 360 wide (W below); the
# ring, name and status sit as one block centred in the window, as in the picked design
MARK_FRAMES, MARK_W, MARK_H = 8, 66, 54      # static/images/mark-splash.png
PLAIN = {"cache": "Clearing caches", "loading": "Loading modules",
         "ports": "Releasing ports", "deps": "Checking dependencies",
         "daemon": "Starting the Session Engine", "server": "Starting the server",
         "browser": "Opening the browser"}

# The status line is a picture too (static/images/status-splash.png, one 18 px
# row per text, drawn in the app's Geist like the name above it): in Tk it fell
# back to another typeface and size, and clashed with the name.
STATUS_ROWS = ["start", "cache", "loading", "ports", "deps", "daemon",
               "server", "browser", "ready", "failed"]
STATUS_W, STATUS_H = 300, 18
# The percentage under the status line: one picture row per value, 0% to 100%
# (static/images/percent-splash.png), for the same reason as the status.
PCT_W, PCT_H = 80, 18

STEPS = [
    ("cache",   "Clearing caches"),
    ("loading", "Loading modules"),
    ("ports",   "Releasing ports"),
    ("deps",    "Checking dependencies"),
    ("daemon",  "Starting session daemon"),
    ("server",  "Initializing server"),
    ("browser", "Opening browser"),
]

W, H = 360, 400
S = 1.0              # set from the screen in BootSplash.__init__ (_fit_screen)


def _fit_screen(screen_h: int) -> float:
    """How much to enlarge the splash: the design is drawn for a 900 px tall
    screen, so a 1800 px screen at 100% scaling gets 2x (1.5x still looked
    small, seen through a remote desktop that shrinks the whole screen).
    One of 1, 1.5 or 2: the logo and name ship as pictures made for exactly
    those sizes (``<name>@1.5x.png``, ``<name>@2x.png``), because Tk can only
    resize a picture by whole steps and Pillow's Tk support is often missing."""
    want = screen_h / 900
    return 2.0 if want >= 1.85 else 1.5 if want >= 1.35 else 1.0


def _scale_layout(scale: float) -> None:
    global S, W, H, RING_CX, RING_CY, RING_R, MARK_W, MARK_H
    S = scale
    W, H = round(360 * S), round(400 * S)
    RING_CX, RING_CY, RING_R = round(180 * S), round(153 * S), round(68 * S)
    MARK_W, MARK_H = round(66 * S), round(54 * S)
    global STATUS_W, STATUS_H
    STATUS_W, STATUS_H = round(300 * S), round(18 * S)
    global PCT_W, PCT_H
    PCT_W, PCT_H = round(80 * S), round(18 * S)


def _px(n: float) -> int:
    return round(n * S)
FRAME_MS = 16        # ~60 fps
NUM_PARTICLES = 0     # the ring design has no particles

# VibeNode app palette (matches src/web/static/style.css dark theme)
C = dict(
    base="#111111", mantle="#0d0d0d", crust="#0a0a0a",
    text="#e8e8e8", subtext="#cccccc", overlay="#888888",
    surface2="#555555", surface1="#333333", surface0="#2a2a2a",
    blue="#7c7cff", lavender="#aaaaff", sapphire="#9a9aff",
    green="#3fb950", teal="#88cc88", red="#f85149",
    mauve="#bc8cff", peach="#d29922", yellow="#d29922",
    sky="#58a6ff", flamingo="#ccccff", rosewater="#e8e8e8",
)

PARTICLE_PALETTES = [C["blue"], C["lavender"], C["mauve"], C["sapphire"], C["sky"]]


# ── Helpers ───────────────────────────────────────────────────────────

def lerp_color(c1, c2, t):
    """Linearly interpolate between two hex colors."""
    t = max(0.0, min(1.0, t))
    r1, g1, b1 = int(c1[1:3], 16), int(c1[3:5], 16), int(c1[5:7], 16)
    r2, g2, b2 = int(c2[1:3], 16), int(c2[3:5], 16), int(c2[5:7], 16)
    return f"#{int(r1+(r2-r1)*t):02x}{int(g1+(g2-g1)*t):02x}{int(b1+(b2-b1)*t):02x}"


def ease_out_cubic(t):
    return 1 - (1 - t) ** 3


# ── Particle ──────────────────────────────────────────────────────────

class Particle:
    __slots__ = ("x", "y", "size", "speed", "wobble_amp", "wobble_freq",
                 "phase", "base_color", "rendered_color")

    def __init__(self):
        self.reset(initial=True)

    def reset(self, initial=False):
        self.x = random.uniform(0, W)
        self.y = random.uniform(0, H) if initial else random.uniform(H, H + 60)
        self.size = random.uniform(1.5, 4.0)
        self.speed = random.uniform(0.2, 0.7)
        self.wobble_amp = random.uniform(0.3, 1.2)
        self.wobble_freq = random.uniform(0.008, 0.03)
        self.phase = random.uniform(0, math.tau)
        self.base_color = random.choice(PARTICLE_PALETTES)
        alpha = random.uniform(0.12, 0.35)
        self.rendered_color = lerp_color(C["base"], self.base_color, alpha)

    def update(self, frame):
        self.y -= self.speed
        self.x += math.sin(frame * self.wobble_freq + self.phase) * self.wobble_amp * 0.3
        if self.y < -10:
            self.reset()


# ── Boot Splash ───────────────────────────────────────────────────────

class BootSplash:

    def __init__(self, status_file: str):
        self.status_file = status_file
        self.current_step = None
        self.completed: set = set()
        self.done = False
        self._last_read_pos = 0
        self._frame = 0
        self._start_time = time.time()

        # ── Lifecycle / crash-safety ──────────────────────────────────
        # The render loop, status poller, and timeout each run on their own
        # root.after() chain.  If the root is destroyed (timeout, auto-close,
        # dismiss) while another chain still has a callback queued, that stale
        # callback fires into a torn-down Tcl interpreter and Tk aborts with a
        # native panic (0x80000003) — the recurring pythonw/tcl86t.dll crash.
        # Track every pending after-id, cancel them all on teardown, and gate
        # every callback on _alive so nothing touches Tk after destroy.
        self._alive = True
        self._after_ids: set = set()

        # Animation state
        self._target_progress = 0.0
        self._current_progress = 0.0
        self._shimmer_x = -0.4
        self._fade_alpha = 0.0
        self._glow_phase = 0.0
        self._completion_flash: dict = {}   # step_id -> frame when completed
        self._finish_time = None
        self._finish_frame = 0

        # Total estimated boot time (seconds) for linear countdown
        self._eta_total = 8

        # Platform font
        if sys.platform == "win32":
            self._ff = "Segoe UI"
        elif sys.platform == "darwin":
            self._ff = "SF Pro Display"
        else:
            self._ff = "sans-serif"

        # Title font: prefer Space Grotesk (matches web UI header)
        self._tf = "Space Grotesk"

        # ── Window ────────────────────────────────────────────────────
        self.root = tk.Tk()

        # Linux font detection — must happen after Tk root is created
        # because tkinter.font.families() requires a running Tk instance.
        if sys.platform not in ("win32", "darwin"):
            try:
                import tkinter.font as _tkfont
                _available = set(_tkfont.families())
                for _candidate in ("Ubuntu", "Noto Sans", "DejaVu Sans", "Liberation Sans"):
                    if _candidate in _available:
                        self._ff = _candidate
                        break
            except Exception:
                pass
        self.root.title("DevelopNode")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.0)          # start invisible

        sx = self.root.winfo_screenwidth()
        sy = self.root.winfo_screenheight()
        _scale_layout(_fit_screen(sy))
        self.root.geometry(f"{W}x{H}+{(sx - W) // 2}+{(sy - H) // 2}")

        # ── Canvas ────────────────────────────────────────────────────
        self.cv = tk.Canvas(self.root, width=W, height=H,
                            bg=C["base"], highlightthickness=0)
        self.cv.pack(fill=tk.BOTH, expand=True)

        self._dx = self._dy = 0
        self.cv.bind("<Button-1>", self._on_press)
        self.cv.bind("<B1-Motion>", self._on_drag)

        # ── Build scene (order = z-order, first = bottom) ─────────────
        self._draw_background()
        self._create_particles()
        self._create_border_sweep()
        self._create_ui()
        self._create_progress_bar()
        self._create_steps()

        # ── Start loops ───────────────────────────────────────────────
        self._schedule(FRAME_MS, self._render)
        self._schedule(150, self._poll)
        self._schedule(90_000, self._timeout)

    # ── Background (static gradient, drawn once) ──────────────────────
    def _draw_background(self):
        # A soft glow behind the ring, fading to the window's dark edge.
        self.cv.create_rectangle(0, 0, W, H, fill="#0c0c10", outline="")
        steps = 46
        for i in range(steps):
            t = i / (steps - 1)
            r = (250 * (1 - t) + 4) * S
            col = lerp_color("#0c0c10", "#1a1a26", t ** 1.6)
            self.cv.create_oval(RING_CX - r, RING_CY - r, RING_CX + r, RING_CY + r,
                                fill=col, outline="")
        for edge in [(0, 0, W, 0), (0, H - 1, W, H - 1),
                     (0, 0, 0, H), (W - 1, 0, W - 1, H)]:
            self.cv.create_line(*edge, fill=C["surface0"])

    # ── Particles (pre-created ovals, moved each frame) ───────────────
    def _create_particles(self):
        self.particles = [Particle() for _ in range(NUM_PARTICLES)]
        self._p_ids = []
        for p in self.particles:
            oid = self.cv.create_oval(
                p.x - p.size, p.y - p.size,
                p.x + p.size, p.y + p.size,
                fill=p.rendered_color, outline="")
            self._p_ids.append(oid)

    # ── Border sweep (pre-created rects for animated glow) ────────────
    def _create_border_sweep(self):
        # 3 layered glow rects per edge (top + bottom = 6)
        self._sweep = []
        for _ in range(6):
            self._sweep.append(
                self.cv.create_rectangle(0, 0, 0, 0, fill="", outline=""))

    # ── UI elements ───────────────────────────────────────────────────
    def _create_ui(self):
        cx = W // 2

        # Close button
        self._close = self.cv.create_text(
            W - _px(22), _px(18), text="\u2715", font=(self._ff, _px(12)),
            fill=C["overlay"], tags="close")
        self.cv.tag_bind("close", "<Button-1>", lambda _: self._destroy())
        self.cv.tag_bind("close", "<Enter>",
                         lambda _: self.cv.itemconfigure(self._close,
                                                         fill=C["text"]))
        self.cv.tag_bind("close", "<Leave>",
                         lambda _: self.cv.itemconfigure(self._close,
                                                         fill=C["overlay"]))

        # The ring design (picked from four): the logo mark alone inside a
        # ring that fills as the app starts, the name small underneath, the
        # current step under it.  Logo and name are pictures rendered from
        # the app's own font (static/images/mark-splash.png, a strip of
        # frames in which the dot breathes, and name-splash.png): Tk cannot
        # space letters and most computers lack that font.
        _img = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "images")
        self._mark_frames = []
        try:
            strip = self._picture(_img, "mark-splash", (MARK_W * MARK_FRAMES, MARK_H))
            for i in range(MARK_FRAMES):
                f = tk.PhotoImage(width=MARK_W, height=MARK_H)
                f.tk.call(f, "copy", strip, "-from",
                          i * MARK_W, 0, (i + 1) * MARK_W, MARK_H)
                self._mark_frames.append(f)
            self._mark_strip = strip
        except Exception:
            self._mark_frames = []
        if self._mark_frames:
            self._mark = self.cv.create_image(RING_CX, RING_CY, image=self._mark_frames[0])
        else:
            self._mark = self.cv.create_text(RING_CX, RING_CY, text=">.",
                                             font=(self._tf, _px(34), "bold"), fill=C["text"])
        self._logo_img = None
        try:
            self._name_img = self._picture(_img, "name-splash", None)
            self.cv.create_image(cx, RING_CY + _px(111), image=self._name_img)
        except Exception:
            self.cv.create_text(cx, RING_CY + _px(111), text="DevelopNode\u2122",
                                font=(self._tf, _px(13), "bold"), fill="#bbbbbb")
        # The title glow and title are kept (the finish code tints them) but empty.
        self._tglow = []
        self._title = self.cv.create_text(-100, -100, text="")

        # Current step, in plain words
        self._sub = self.cv.create_text(
            cx, RING_CY + _px(137), text="Starting up\u2026",
            font=(self._ff, _px(9)), fill="#777777")
        self._status_frames = {}
        try:
            strip = self._picture(_img, "status-splash", None)
            for i, key in enumerate(STATUS_ROWS):
                f = tk.PhotoImage(width=STATUS_W, height=STATUS_H)
                f.tk.call(f, "copy", strip, "-from",
                          0, i * STATUS_H, STATUS_W, (i + 1) * STATUS_H)
                self._status_frames[key] = f
            self._status_strip = strip
            self._status_img = self.cv.create_image(cx, RING_CY + _px(137),
                                                    image=self._status_frames["start"])
            self.cv.itemconfigure(self._sub, text="")     # the picture says it
        except Exception:
            self._status_frames = {}
        self._pct_frames = []
        self._pct_shown = -1
        try:
            strip = self._picture(_img, "percent-splash", None)
            for i in range(101):
                f = tk.PhotoImage(width=PCT_W, height=PCT_H)
                f.tk.call(f, "copy", strip, "-from", 0, i * PCT_H, PCT_W, (i + 1) * PCT_H)
                self._pct_frames.append(f)
            self._pct_strip = strip
            self._pct_img = self.cv.create_image(cx, RING_CY + _px(160), image=self._pct_frames[0])
        except Exception:
            self._pct_frames = []

        # Error text + dismiss button (hidden until error)
        self._err = self.cv.create_text(
            cx, H - _px(70), text="", font=(self._ff, _px(9)),
            fill=C["red"], width=W)
        self._dismiss_bg = self.cv.create_rectangle(
            cx - _px(50), H - _px(42), cx + _px(50), H - _px(18),
            fill="", outline="", tags="dismiss")
        self._dismiss_txt = self.cv.create_text(
            cx, H - _px(30), text="", font=(self._ff, _px(9)),
            fill="", tags="dismiss")
        self.cv.tag_bind("dismiss", "<Button-1>", lambda _: self._destroy())

    def _show_status(self, key) -> bool:
        """Show the status picture for ``key``; False when there is none."""
        f = self._status_frames.get(key)
        if f is None:
            return False
        self.cv.itemconfigure(self._status_img, image=f)
        return True

    def _picture(self, folder, name, size):
        """The splash picture made for the current size (see _fit_screen)."""
        tag = "" if S == 1.0 else "@%gx" % S
        return tk.PhotoImage(file=os.path.join(folder, name + tag + ".png"))

    # ── Progress bar ──────────────────────────────────────────────────
    def _create_progress_bar(self):
        x0, y0 = RING_CX - RING_R, RING_CY - RING_R
        x1, y1 = RING_CX + RING_R, RING_CY + RING_R
        self.cv.create_oval(x0, y0, x1, y1, outline="#24242c", width=_px(3))
        # extent 0 draws nothing; the arc grows clockwise from the top
        self._ring = self.cv.create_arc(x0, y0, x1, y1, start=90, extent=0,
                                        style="arc", outline="#8B8FF7", width=_px(3))
        # Kept for the shared finish and timer code, never shown.
        self._pct = self.cv.create_text(-100, -100, text="")
        self._time_elapsed = self.cv.create_text(-100, -100, text="")
        self._time_remaining = self.cv.create_text(-100, -100, text="")

    # ── Steps — 3D cylinder carousel (shows ~3 at a time) ────────────
    def _create_steps(self):
        self._step_cy = 260          # vertical center of carousel
        self._step_radius = 55       # cylinder radius in pixels
        self._step_angle = math.pi / 3   # 60° per step slot
        self._scroll_current = 0.0   # smoothly animated scroll position
        self._scroll_target = 0.0

        self._si = {}
        for i, (sid, label) in enumerate(STEPS):
            sym = self.cv.create_text(
                0, -100, text="\u25CB",
                font=(self._ff, 12), fill=C["surface2"], anchor="center")
            txt = self.cv.create_text(
                0, -100, text=label,
                font=(self._ff, 11), fill=C["surface2"], anchor="w")
            ring = self.cv.create_oval(0, 0, 0, 0,
                                       outline="", fill="", width=2)
            self._si[sid] = dict(sym=sym, txt=txt, ring=ring, idx=i)

    # ── Drag ──────────────────────────────────────────────────────────
    def _on_press(self, e):
        self._dx, self._dy = e.x, e.y

    def _on_drag(self, e):
        x = self.root.winfo_x() + e.x - self._dx
        y = self.root.winfo_y() + e.y - self._dy
        self.root.geometry(f"+{x}+{y}")

    # ==================================================================
    #  RENDER LOOP  (~60 fps)
    # ==================================================================
    def _render(self):
        if not self._alive:
            return
        # Auto-close after completion
        if self.done and self._finish_time:
            if time.time() - self._finish_time > 1.2:
                self._destroy()
                return

        try:
            self._frame += 1

            # Fade in
            if self._fade_alpha < 1.0:
                self._fade_alpha = min(1.0, self._fade_alpha + 0.035)
                self.root.attributes("-alpha",
                                     ease_out_cubic(self._fade_alpha))

            # Update time-based progress target
            self._recalc_target()

            # Smooth eased progress interpolation
            diff = self._target_progress - self._current_progress
            self._current_progress += diff * 0.06
            if abs(diff) < 0.002:
                self._current_progress = self._target_progress

            self._r_progress()
            self._r_title()
            self._r_mark()
        except Exception:
            pass

        self._schedule(FRAME_MS, self._render)

    # ── Particle motion ───────────────────────────────────────────────
    def _r_particles(self):
        for i, p in enumerate(self.particles):
            p.update(self._frame)
            self.cv.coords(self._p_ids[i],
                           p.x - p.size, p.y - p.size,
                           p.x + p.size, p.y + p.size)
            # Occasional twinkle
            if self._frame % 60 == i % 60:
                p.rendered_color = lerp_color(
                    C["base"], p.base_color, random.uniform(0.1, 0.4))
                self.cv.itemconfigure(self._p_ids[i], fill=p.rendered_color)

    # ── Progress bar, shimmer, percentage ─────────────────────────────
    def _r_progress(self):
        prog = self._current_progress
        col = "#8B8FF7"
        if self.done and self._finish_time:
            age = self._frame - self._finish_frame
            col = lerp_color("#ffffff", C["green"], ease_out_cubic(min(1.0, age / 20)))
        self.cv.itemconfigure(self._ring, extent=-359.9 * max(0.0, min(1.0, prog)), outline=col)
        if self._pct_frames:
            n = 100 if (self.done and self._finish_time) else int(max(0.0, min(1.0, prog)) * 100 + 1e-6)
            if n != self._pct_shown:
                self._pct_shown = n
                self.cv.itemconfigure(self._pct_img, image=self._pct_frames[n])

    def _r_mark(self):
        # The dot breathes while starting; still once finished.
        if self._mark_frames:
            i = 0 if self.done else (self._frame // 6) % MARK_FRAMES
            self.cv.itemconfigure(self._mark, image=self._mark_frames[i])
        if not self.done and self.current_step:
            if not self._show_status(self.current_step):
                self.cv.itemconfigure(self._sub, text=PLAIN.get(self.current_step, self.current_step) + "\u2026")

    # ── Title glow breathing ──────────────────────────────────────────
    def _r_title(self):
        self._glow_phase += 0.025
        intensity = 0.12 + 0.08 * math.sin(self._glow_phase)

        if self.done:
            glow = lerp_color(C["base"], C["green"], intensity)
            self.cv.itemconfigure(self._title, fill=C["green"])
        else:
            glow = lerp_color(C["base"], C["blue"], intensity)

        for g in self._tglow:
            self.cv.itemconfigure(g, fill=glow)

    # ── 3D cylinder carousel renderer ─────────────────────────────────
    def _r_steps(self):
        # Smooth scroll interpolation
        diff = self._scroll_target - self._scroll_current
        self._scroll_current += diff * 0.08
        if abs(diff) < 0.005:
            self._scroll_current = self._scroll_target

        cy = self._step_cy
        R = self._step_radius
        sa = self._step_angle
        cx = W // 2
        pulse_syms = ["\u25CF", "\u25C9", "\u25CB", "\u25C9"]

        for sid, s in self._si.items():
            idx = s["idx"]

            # Distance guard: hide steps more than 2.5 slots away from the
            # current scroll position.  Without this, cos() periodicity causes
            # a step at distance 6 (= one full 2π cycle at π/3/step) to land
            # at the same screen y-coordinate as a nearby step, producing
            # visually overlapping / duplicate text — with 8 steps, two
            # wrap-around ghosts appeared on screen simultaneously at scroll
            # positions 0 and 1.  Keep the guard regardless of len(STEPS).
            if abs(idx - self._scroll_current) > 2.5:
                self.cv.coords(s["sym"], -100, -100)
                self.cv.coords(s["txt"], -100, -100)
                self.cv.itemconfigure(s["ring"], outline="")
                continue

            angle = (idx - self._scroll_current) * sa

            # facing = how much this slot faces the viewer (1=front, 0=edge)
            facing = math.cos(angle)

            if facing <= 0.05:
                # Behind the cylinder — hide offscreen
                self.cv.coords(s["sym"], -100, -100)
                self.cv.coords(s["txt"], -100, -100)
                self.cv.itemconfigure(s["ring"], outline="")
                continue

            # 3D position on cylinder surface
            y = cy + math.sin(angle) * R

            sym_x = cx - 70
            txt_x = cx - 45

            self.cv.coords(s["sym"], sym_x, y)
            self.cv.coords(s["txt"], txt_x, y)

            # Font sizes scale with facing (bigger = closer)
            sf = int(10 + facing * 4)    # sym: 10–14
            tf = int(9 + facing * 3)     # txt: 9–12

            # ── Determine state + base color ──────────────────────
            if sid in self.completed:
                base_col = C["green"]
                sym_text = "\u2713"
                sym_font = (self._ff, sf, "bold")

                # Completion flash + ring burst
                if sid in self._completion_flash:
                    age = self._frame - self._completion_flash[sid]
                    if age < 0:
                        base_col = C["surface2"]
                        sym_text = "\u25CB"
                        sym_font = (self._ff, sf)
                    elif age < 20:
                        t = ease_out_cubic(age / 20)
                        base_col = lerp_color("#ffffff", C["green"], t)
                        ring_r = 8 + age * 0.8
                        self.cv.coords(s["ring"],
                                       sym_x - ring_r, y - ring_r,
                                       sym_x + ring_r, y + ring_r)
                        self.cv.itemconfigure(
                            s["ring"],
                            outline=lerp_color(C["base"], C["green"],
                                               (1 - t) * 0.6),
                            width=2)
                    else:
                        self.cv.itemconfigure(s["ring"], outline="")

            elif sid == self.current_step:
                ci = (self._frame // 10) % len(pulse_syms)
                gp = 0.5 + 0.5 * math.sin(self._frame * 0.08)
                base_col = lerp_color(C["blue"], C["lavender"], gp * 0.5)
                sym_text = pulse_syms[ci]
                sym_font = (self._ff, sf)

            else:
                base_col = C["surface2"]
                sym_text = "\u25CB"
                sym_font = (self._ff, sf)
                self.cv.itemconfigure(s["ring"], outline="")

            # Apply facing as depth fade
            col = lerp_color(C["base"], base_col, facing * 0.85 + 0.15)

            self.cv.itemconfigure(s["sym"], text=sym_text, fill=col,
                                  font=sym_font)
            self.cv.itemconfigure(s["txt"], fill=col, font=(self._ff, tf))

    # ── Elapsed / ETA timer ───────────────────────────────────────────
    def _r_time(self):
        elapsed = time.time() - self._start_time

        if self.done:
            self.cv.itemconfigure(
                self._time_elapsed,
                text=f"{elapsed:.1f}s", fill=C["surface2"])
            self.cv.itemconfigure(self._time_remaining, text="")
            return

        es = int(elapsed)
        self.cv.itemconfigure(self._time_elapsed, text=f"{es}s")
        remaining = max(0, self._eta_total - elapsed)
        if remaining > 0:
            rem = max(1, int(remaining))
            self.cv.itemconfigure(self._time_remaining, text=f"~{rem}s left")
        else:
            self.cv.itemconfigure(self._time_remaining, text="")

    # ── Animated gradient border sweep ────────────────────────────────
    def _r_border(self):
        pos = ((self._frame * 1.5) % (W + 200)) - 100

        widths = [60, 30, 10]
        alphas = [0.1, 0.25, 0.5]
        top_cols = [C["blue"], C["blue"], C["lavender"]]
        bot_cols = [C["mauve"], C["mauve"], C["lavender"]]

        for i in range(3):
            # Top edge (left to right)
            sx, ex = pos - widths[i], pos + widths[i]
            self.cv.coords(self._sweep[i], sx, 0, ex, 2)
            self.cv.itemconfigure(
                self._sweep[i], outline="",
                fill=lerp_color(C["crust"], top_cols[i], alphas[i]))

            # Bottom edge (right to left)
            bp = W - pos
            sx, ex = bp - widths[i], bp + widths[i]
            self.cv.coords(self._sweep[3 + i], sx, H - 2, ex, H)
            self.cv.itemconfigure(
                self._sweep[3 + i], outline="",
                fill=lerp_color(C["crust"], bot_cols[i], alphas[i]))

    # ==================================================================
    #  STATUS FILE POLLING
    # ==================================================================
    def _poll(self):
        if not self._alive:
            return
        try:
            if os.path.exists(self.status_file):
                with open(self.status_file, "r", encoding="utf-8") as fh:
                    fh.seek(self._last_read_pos)
                    lines = fh.readlines()
                    self._last_read_pos = fh.tell()
                for raw in lines:
                    line = raw.strip()
                    if not line:
                        continue
                    if line == "DONE":
                        self._finish_ok()
                        return
                    if line.startswith("ERROR:"):
                        self._finish_error(line[6:].strip())
                        return
                    if line.startswith("STEP:"):
                        self._activate(line.split(":", 2)[1])
        except Exception:
            pass
        if not self.done:
            self._schedule(150, self._poll)

    def _activate(self, step_id):
        if self.current_step and self.current_step != step_id:
            self._mark_done(self.current_step)
        self.current_step = step_id
        # Record when this step started for intra-step decay
        if step_id in self._si:
            self._si[step_id]["_started"] = time.time()
            self._scroll_target = self._si[step_id]["idx"]
        self._recalc_target()

    def _mark_done(self, step_id):
        if step_id not in self.completed:
            self.completed.add(step_id)
            self._completion_flash[step_id] = self._frame
        self._recalc_target()

    def _recalc_target(self):
        """Step-capped continuous progress.

        A slow global time-based curve keeps the bar always moving, but it
        is capped so it can never get more than one step ahead of reality.
        This means: floor (completed steps) + current step's slice is the
        ceiling.  The time curve fills up to that ceiling naturally, so
        there's constant motion without overshooting what's actually done."""
        if self.done:
            return
        n = len(STEPS)
        slice_size = 0.95 / n

        # Ceiling: completed steps + the active step's full slice
        done_count = len(self.completed)
        if self.current_step and self.current_step not in self.completed:
            ceiling = (done_count + 1) * slice_size
        else:
            ceiling = done_count * slice_size

        # Global time curve: always moving, asymptotes toward 95%
        elapsed = time.time() - self._start_time
        T = self._eta_total
        if elapsed <= T:
            time_p = 0.95 * (elapsed / T)
        else:
            time_p = 0.95 + 0.04 * (1 - math.exp(-(elapsed - T) / 10))

        # Take the lesser of the time curve and the step ceiling
        self._target_progress = min(time_p, ceiling, 0.99)

    # ── Finish states ─────────────────────────────────────────────────
    def _finish_ok(self):
        self.done = True
        self._finish_time = time.time()
        self._finish_frame = self._frame
        self.current_step = None
        self._target_progress = 1.0
        # Scroll to last step and staggered completion cascade
        self._scroll_target = len(STEPS) - 1
        for i, (sid, _) in enumerate(STEPS):
            if sid not in self.completed:
                self.completed.add(sid)
                self._completion_flash[sid] = self._frame + i * 4
        if not self._show_status("ready"):
            self.cv.itemconfigure(self._sub, text="Ready", fill=C["green"])

    def _finish_error(self, msg):
        self.done = True
        self._finish_time = None                     # don't auto-close
        self._show_status("failed")
        if self._pct_frames:
            self.cv.itemconfigure(self._pct_img, state="hidden")   # room for the error
        self.cv.itemconfigure(self._sub, text="" if self._status_frames else "Startup failed",
                              fill=C["red"])
        self.cv.itemconfigure(self._err, text=msg)
        self.cv.itemconfigure(self._dismiss_bg,
                              fill=C["surface1"], outline=C["surface2"])
        self.cv.itemconfigure(self._dismiss_txt,
                              text="Dismiss", fill=C["text"])
        self.root.attributes("-topmost", False)

    def _timeout(self):
        if not self._alive:
            return
        if not self.done:
            self._destroy()

    def _schedule(self, ms, fn):
        """root.after() that no-ops once torn down and records its id so
        _destroy() can cancel every still-pending callback."""
        if not self._alive:
            return
        try:
            self._after_ids.add(self.root.after(ms, fn))
        except Exception:
            pass

    def _destroy(self):
        # Idempotent, crash-safe teardown.  Cancel every pending after()
        # FIRST so no stale render/poll/timeout callback can fire into a
        # half-destroyed Tcl interpreter (the native-panic crash), then quit
        # the loop and destroy the root.
        if not self._alive:
            return
        self._alive = False
        for aid in list(self._after_ids):
            try:
                self.root.after_cancel(aid)
            except Exception:
                pass
        self._after_ids.clear()
        try:
            self.root.quit()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass

    def run(self):
        try:
            self.root.mainloop()
        except Exception:
            pass


# ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        sys.exit(1)
    try:
        splash = BootSplash(sys.argv[1])
        splash.run()
    except Exception:
        pass


if __name__ == "__main__":
    main()
