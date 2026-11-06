# Official ICPC Reaction generator

The dedicated Reaction worker calls the official [`icpc/reactions-generator`](https://github.com/icpc/reactions-generator) `reaction` CLI. It does not use the network-only `single` command, because the recordings and authoritative submission metadata already belong to this application. Generation runs outside web requests and judging, with the worker's generation concurrency limited to one by default.

## Windows installation

From the repository root in PowerShell:

```powershell
.\scripts\setup-reaction-generator.ps1
```

This installs the tested upstream revision `59fd21d50e8bf4c69bd6e4b5c19a60726f30a20b` and an isolated Python environment under ignored `tmp/`. It preserves existing checkouts and environments. Python 3.12+, Git, FFmpeg and FFprobe must be available. Copy the two printed paths into `apps/web/.env`; the installer does not overwrite `.env`.

```dotenv
REACTION_GENERATOR_ROOT="C:/absolute/path/to/reactions-generator"
REACTION_GENERATOR_PYTHON="C:/absolute/path/to/venv/Scripts/python.exe"
REACTION_GENERATOR_TIMEOUT_SECONDS=1800
# Optional when starting the worker outside apps/web:
REACTION_GENERATOR_ADAPTER="C:/absolute/path/to/apps/web/scripts/reaction-generator-cli.py"
# Optional executable overrides for input/output validation:
FFMPEG_PATH="C:/absolute/path/to/ffmpeg.exe"
FFPROBE_PATH="C:/absolute/path/to/ffprobe.exe"
# Optional font family override (must cover the team/school names):
REACTION_GENERATOR_FONT="C:/Windows/Fonts/msyh.ttc"
# Optional matching title face; regular and bold are separate roles:
REACTION_GENERATOR_FONT_BOLD="C:/Windows/Fonts/msyhbd.ttc"
```

The upstream Python CLI also needs `ffmpeg` and `ffprobe` on its inherited `PATH`.

## Storage admission

The exam's configured persistent-storage budget includes active desktop/camera `MediaSegment.byteSize`, `Reaction.outputBytes` (camera, desktop, metadata and generated MP4), and `Reaction.reservedBytes` for output currently being published. Admission and settlement use the exam row lock. A new output is reserved before storage publication; replacement keeps the old MP4 counted until the new result is adopted. A rejected or cancelled attempt removes its own UUID-scoped objects and releases its reservation. Retention clears accounting with the expired references and uses the existing durable deletion queue for physical removal. The worker recovers abandoned reservations after lease expiry.

Temporary decode/render files and files awaiting deletion retries are outside that persistent logical budget. Provide additional scratch disk space for at least the largest simultaneous capture/generation attempt and monitor host free space. The single FFmpeg job limits the simultaneous scratch peak; this budget is not an operating-system disk quota. Reaction is a new schema feature; if importing pre-existing Reaction rows with output paths, populate `outputBytes` from those objects before enabling admission checks.

On Linux, clone the same revision, run `python3.12 -m venv`, install the repository with `pip install /path/to/reactions-generator typed-ffmpeg==3.11 typer==0.20.1`, and use `venv/bin/python` in the configuration.

## Input and output rules

`generateReactionVideo()` takes local materialized camera/desktop MP4 paths and returns verified output metadata. The caller handles authenticated local/S3 storage and only publishes the returned file after success. Both inputs are probed and fully decoded before generation. COMPLETE inputs retain the synchronized-duration check (within250ms). An existing PARTIAL recording may opt into `allowPartial: true` with `windowDurationSeconds`: keep the original common starting time, select the minimum of both video durations and the original window, and round down on the25fps capture clock. The generator never extends a shorter input to match the longer one. The output must fully decode and be1080×1920 H.264; degraded output cannot exceed the available minimum duration.

Generation never promotes PARTIAL to COMPLETE. Original gaps, sparse-frame/clock diagnostics and the raw files remain intact; only `generationStatus` becomes COMPLETE after a successful render. `metadata.generation` records `degraded`, `sourceStatus`, `incompleteReason`, the aligned start/selected end, actual output duration and `generationWindow` with both input durations and the selected minimum. If the observed judgement falls outside the selected prefix (including exactly its endpoint), the official card remains pending yellow with ellipsis; future rank changes, verdict animation and action sound are suppressed. The original observation offset is retained in metadata as `OUTSIDE_TRIMMED_WINDOW_WAITING`, never moved earlier. Missing/unplayable desktop sources, MISSING and EXPIRED recordings remain ineligible.

A PARTIAL record with a playable desktop and no camera can also be generated. The official webcam area uses the neutral built-in `assets/reaction-camera-placeholder.svg`, visibly labelled “未提供摄像头画面”. Its duration is the minimum of desktop duration and the original window, rounded down to25fps. The temporary template never becomes a stored `cameraPath`, never limits the desktop duration and never implies that camera evidence exists. `metadata.generation` records `cameraSource: "placeholder"`, `cameraPlaceholderReason` and `cameraTemplateBasis: "built-in:reaction-camera-placeholder-v1"`; `generationWindow.cameraDurationSeconds` is null and its policy is `DESKTOP_START_MIN_DURATION`. Existing camera files are always read and fully decoded first: a damaged or unreadable object fails explicitly. An old black filler is replaced only when capture metadata explicitly shows empty slices or verified timestamps prove zero retained frames in every slice. An invalid/unknown timestamp audit with `selectedFrames=0` does not prove absence. Black pixels alone are never used to classify a camera as missing. A valid real camera keeps `cameraSource: "recording"`.

`contestTimeMs` is contest elapsed time **of the submission**, read from the persisted CCS `submissions.contest_time`; it does not assume NovaJudge and the proctoring exam have the same start time. If CCS omits that duration, the exam elapsed-time fallback is explicitly identified in metadata. `judgementOffsetSeconds` is the server observation time minus the common start of both raw clips, not the synthetic CCS `end_time`. The adapter anchors the official card animation and its sound to that point; the displayed contest timestamp identifies the submission. Missing ranks hide the rank badge; missing school text is blank; the integrated recorder resolves a global organization badge, then the configured system default, then a neutral built-in badge. The low-level CLI adapter still collapses the logo column if invoked directly without any logo. No rank, school or logo is invented. The default sky-blue technology background is the editable repository SVG at `apps/web/assets/reaction-background.svg`, rasterized by Sharp. Camera, desktop, card shapes, verdict colors and animation still come from the official implementation.

The server can pass local materialized presentation assets to `generateReactionVideo`:

```ts
presentation: {
  logoPath?: string;       // Materialized system organization/default badge.
  backgroundPath?: string;
  fontPreset?: 'broadcast' | 'classic';
}
```

The web upload boundary accepts PNG/JPEG/WebP up to 4MiB and 16 million decoded pixels, re-encoded as PNG; URLs are not accepted. The lower-level generator additionally bounds trusted local inputs at 20MiB and 40 million decoded pixels. The background is normalized to 1080×1920 using a centered cover crop. The logo preserves its aspect/alpha on a circular white backing. Asset file paths are transient worker inputs and are not written into the delivered metadata. Production generation always supplies the exact system organization badge, system default, or a neutral built-in badge. It does not infer a university logo or use legacy per-exam logo overrides; see [system organization branding](reaction-branding.md). `broadcast` uses installed Noto Sans SC/CJK (real weight700 title and weight400 subtitle), with Microsoft YaHei as fallback; `classic` prefers Microsoft YaHei Bold/Regular. The problem letter keeps the official bold font; the verdict/time uses a separate sans monospaced face (Consolas/DejaVu Sans Mono or official fallback). Both presets use the same default background; selecting a font never implicitly changes the background. Long titles may wrap, but are not horizontally squeezed. The official before/after-rank animation is enabled only when both verified ranks are supplied.

The small Python adapter changes only the unknown-rank badge, observation timing, fixed submission clock, deployment typography, missing-logo spacing, output duration and FFmpeg thread limits. It invokes the official Typer CLI after these runtime adaptations and does not modify the upstream checkout. Encoder/filter concurrency is two threads each. The parent process has a bounded timeout and terminates its own child process tree on timeout. Subprocess arguments never pass through a shell. Temporary input metadata contains no CCS/WHEP credentials and is removed after rendering.

Upstream's bundled Nimbus fonts have limited non-Latin coverage. CJK names automatically select installed Noto Sans SC/CJK or Microsoft YaHei regular/bold faces; if neither is available, install suitable fonts and set the two explicit font paths. Variable-font weight is preserved when the official text layout resizes a font. The adapter fails clearly instead of knowingly rendering missing CJK glyphs. Fonts stay on the host and are not copied into the repository. Other non-Latin scripts can use the same explicit settings. The bundled sounds and fonts retain upstream license notices. See [third-party notices](../THIRD_PARTY_NOTICES.md).

## Acceptance

The local smoke validation uses two real, playable synthetic MP4 inputs to exercise the official CLI. This validates generation only; it is separate from live WHEP, MediaSegment capture, CCS and real judgement integration acceptance. The full `reaction-e2e.ps1` run must validate those paths separately.

```powershell
ffprobe -v error -show_entries stream=codec_name,width,height,duration -of json reaction.mp4
ffmpeg -nostdin -v error -xerror -i reaction.mp4 -f null -
```

## System organization branding

The recorder now resolves badges from System Settings, not per-exam overrides. See [reactions.md](reactions.md) for the exact organization-name matching rules, current-candidate versus recording-snapshot school provenance, private asset access, and background preview. The user-facing upload limit is 4 MiB and 16 million pixels; the 20 MiB materialized-input bound above is a separate internal generator validation limit. Background previews use the same source SVG and centered cover crop as generation. Preview cards are static placement guides; the exported animations remain the upstream official implementation.
