import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export type ReactionGeneratorInput = {
  cameraPath?: string | null;
  /** Only set from server capture provenance, never from pixel colour. */
  cameraPlaceholderReason?: 'MISSING_CAMERA_RECORDING' | 'NO_CAPTURED_CAMERA_FRAMES';
  desktopPath: string;
  outputPath: string;
  teamName: string;
  schoolName?: string | null;
  problemLabel: string;
  verdict: string;
  /** Contest elapsed time of the submission, in milliseconds. */
  contestTimeMs: number;
  /** Judgement observation minus the common start of both input clips. */
  judgementOffsetSeconds: number;
  rankBefore?: number | null;
  rankAfter?: number | null;
  /** Opt in only for an existing PARTIAL recording; never changes its status. */
  allowPartial?: boolean;
  /** Duration of the original common capture window, measured from its start. */
  windowDurationSeconds?: number;
  /** Server-materialized assets only; never public URLs or browser credentials. */
  presentation?: {
    logoPath?: string;
    backgroundPath?: string;
    fontPreset?: 'broadcast' | 'classic';
  };
};

export type ReactionVideoProbe = { duration: number; width: number; height: number; codec: string; bytes: number };
export type ReactionGenerationWindow = ReturnType<typeof planReactionGeneration>;
export type ReactionGenerationResult = ReactionVideoProbe & { generationWindow: ReactionGenerationWindow;
  cameraSource: 'recording' | 'placeholder'; cameraPlaceholderReason: ReactionGeneratorInput['cameraPlaceholderReason'] | null;
  cameraTemplateBasis: 'built-in:reaction-camera-placeholder-v1' | null };

export function planReactionGeneration(cameraDuration: number | null, desktopDuration: number, input: Pick<ReactionGeneratorInput, 'allowPartial' | 'windowDurationSeconds' | 'judgementOffsetSeconds'>) {
  const partial = input.allowPartial === true;
  if (!(Number.isFinite(desktopDuration) && desktopDuration > 0)
    || (cameraDuration === null ? !partial : !Number.isFinite(cameraDuration) || cameraDuration <= 0)
    || !Number.isFinite(input.judgementOffsetSeconds) || input.judgementOffsetSeconds < 0
    || (input.windowDurationSeconds != null && (!Number.isFinite(input.windowDurationSeconds) || input.windowDurationSeconds <= 0))
    || (partial && input.windowDurationSeconds == null)) throw new Error('REACTION_GENERATOR_TIMING_INVALID');
  if (!partial && cameraDuration !== null && Math.abs(cameraDuration - desktopDuration) > .25) throw new Error('REACTION_GENERATOR_INPUTS_NOT_SYNCHRONIZED');
  const minimumAvailableDurationSeconds = Math.min(cameraDuration ?? Infinity, desktopDuration, input.windowDurationSeconds ?? Infinity);
  // Raw capture outputs share a 25fps clock. Round down for degraded output so
  // its final frame never extends beyond the shortest available input/window.
  const selectedDurationSeconds = partial ? Math.floor(minimumAvailableDurationSeconds * 25 + 1e-7) / 25 : minimumAvailableDurationSeconds;
  if (selectedDurationSeconds <= 0) throw new Error('REACTION_GENERATOR_NO_COMMON_VIDEO');
  if (!partial && input.judgementOffsetSeconds > selectedDurationSeconds) throw new Error('REACTION_GENERATOR_JUDGEMENT_OUTSIDE_VIDEO');
  const judgementIncluded = input.judgementOffsetSeconds < selectedDurationSeconds - 1e-6;
  return { policy: cameraDuration === null ? 'DESKTOP_START_MIN_DURATION' as const : 'COMMON_START_MIN_DURATION' as const, degraded: partial,
    cameraDurationSeconds: cameraDuration, desktopDurationSeconds: desktopDuration,
    originalWindowDurationSeconds: input.windowDurationSeconds ?? null,
    minimumAvailableDurationSeconds, selectedDurationSeconds,
    judgementOffsetSeconds: input.judgementOffsetSeconds, judgementIncluded,
    judgementPresentation: judgementIncluded ? 'OBSERVED_AT_ORIGINAL_OFFSET' as const : 'OUTSIDE_TRIMMED_WINDOW_WAITING' as const };
}

/** Commands are argument arrays, never shell strings. Errors contain no command or secrets. */
async function run(executable: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let ended = false;
    const finish = (error?: Error) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(stdout);
    };
    const timer = setTimeout(() => {
      if (child.pid) {
        if (process.platform === 'win32') {
          // Stop this specific child and its FFmpeg descendants, not unrelated encoders.
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }
      finish(new Error('REACTION_GENERATOR_TIMEOUT'));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-1_000_000); });
    // Drain to prevent backpressure. CLI diagnostic output is deliberately not
    // returned to clients; it can contain local paths or source metadata.
    child.stderr.on('data', () => {});
    child.once('error', () => finish(new Error('REACTION_GENERATOR_EXECUTABLE_UNAVAILABLE')));
    child.once('close', (code) => finish(code === 0 ? undefined : new Error(`REACTION_GENERATOR_PROCESS_FAILED_${code}`)));
  });
}

export async function probeReactionVideo(file: string): Promise<ReactionVideoProbe> {
  const info = await stat(file);
  if (!info.isFile() || info.size < 128) throw new Error('REACTION_VIDEO_EMPTY');
  const result = JSON.parse(await run(process.env.FFPROBE_PATH || 'ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ])) as { streams?: { codec_type: string; width?: number; height?: number; codec_name?: string; duration?: string }[]; format?: { duration?: string } };
  const video = result.streams?.find((stream) => stream.codec_type === 'video');
  const duration = Number(video?.duration || result.format?.duration);
  if (!video?.width || !video.height || !video.codec_name || !Number.isFinite(duration) || duration <= 0) throw new Error('REACTION_VIDEO_INVALID');
  return { duration, width: video.width, height: video.height, codec: video.codec_name, bytes: info.size };
}

async function validatePlayable(file: string) {
  const probe = await probeReactionVideo(file);
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-threads', '2', '-i', file, '-map', '0:v:0', '-f', 'null', '-']);
  return probe;
}

async function presentationImage(file: string) {
  if (/[\u0000-\u001f]/.test(file) || /^[a-z]+:\/\//i.test(file)) throw new Error('REACTION_GENERATOR_ASSET_INVALID');
  const resolved = path.resolve(file);
  const info = await stat(resolved);
  if (!info.isFile() || info.size < 1 || info.size > 20 * 1024 * 1024) throw new Error('REACTION_GENERATOR_ASSET_INVALID');
  const image = sharp(resolved, { limitInputPixels: 40_000_000, animated: false });
  const metadata = await image.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format || '')) throw new Error('REACTION_GENERATOR_ASSET_INVALID');
  return image.rotate();
}

async function preparePresentation(input: ReactionGeneratorInput, directory: string, adapter: string) {
  const presentation = input.presentation || {};
  if (presentation.fontPreset && !['broadcast', 'classic'].includes(presentation.fontPreset)) throw new Error('REACTION_GENERATOR_PRESENTATION_INVALID');
  const backgroundPath = path.join(directory, 'background.png');
  if (presentation.backgroundPath) {
    await (await presentationImage(presentation.backgroundPath)).resize(1080, 1920, { fit: 'cover', position: 'centre' }).png().toFile(backgroundPath);
  } else {
    // This editable, repository-owned SVG is a visual template, not a generated
    // imitation of a school/event background. It contains no external assets.
    const template = path.resolve(path.dirname(adapter), '../assets/reaction-background.svg');
    await sharp(template).resize(1080, 1920).png().toFile(backgroundPath);
  }
  const logoPath = path.join(directory, 'logo.png');
  if (presentation.logoPath) {
    const logo = await (await presentationImage(presentation.logoPath)).resize(128, 128, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } }).png().toBuffer();
    const badge = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="152" height="152"><circle cx="76" cy="76" r="75" fill="white"/><circle cx="76" cy="76" r="70" fill="none" stroke="#dcecf4" stroke-width="2"/></svg>');
    await sharp(badge).composite([{ input: logo, left: 12, top: 12 }]).png().toFile(logoPath);
  } else {
    await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toFile(logoPath);
  }
  return { logoPath, backgroundPath, hasLogo: Boolean(presentation.logoPath), fontPreset: presentation.fontPreset || 'broadcast' };
}

async function prepareCameraPlaceholder(directory: string, adapter: string, duration: number) {
  const image = path.join(directory, 'camera-placeholder.png');
  await sharp(path.resolve(path.dirname(adapter), '../assets/reaction-camera-placeholder.svg')).png().toFile(image);
  const video = path.join(directory, 'camera-placeholder.mp4');
  await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-loop', '1', '-framerate', '25', '-i', image,
    '-frames:v', String(Math.round(duration * 25)), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-pix_fmt', 'yuv420p', video]);
  return video;
}

/** Call only from the dedicated recorder worker's bounded generation queue. */
export async function generateReactionVideo(input: ReactionGeneratorInput): Promise<ReactionGenerationResult> {
  const root = process.env.REACTION_GENERATOR_ROOT;
  const python = process.env.REACTION_GENERATOR_PYTHON;
  if (!root || !python) throw new Error('REACTION_GENERATOR_NOT_CONFIGURED');
  await access(root);
  await access(python);
  for (const text of [input.teamName, input.schoolName ?? '', input.problemLabel, input.verdict]) {
    if (text.length > 256 || /[\u0000-\u001f]/.test(text)) throw new Error('REACTION_GENERATOR_METADATA_INVALID');
  }
  if (!Number.isFinite(input.contestTimeMs) || input.contestTimeMs < 0 || !Number.isFinite(input.judgementOffsetSeconds) || input.judgementOffsetSeconds < 0) throw new Error('REACTION_GENERATOR_TIMING_INVALID');
  for (const rank of [input.rankBefore, input.rankAfter]) {
    if (rank != null && (!Number.isSafeInteger(rank) || rank < 1)) throw new Error('REACTION_GENERATOR_RANK_INVALID');
  }
  const cameraPlaceholderReason = input.cameraPath ? input.cameraPlaceholderReason ?? null : 'MISSING_CAMERA_RECORDING';
  if (cameraPlaceholderReason && (!input.allowPartial || !['MISSING_CAMERA_RECORDING', 'NO_CAPTURED_CAMERA_FRAMES'].includes(cameraPlaceholderReason))) throw new Error('REACTION_GENERATOR_CAMERA_PLACEHOLDER_REQUIRES_PARTIAL');
  // Even a provenance-confirmed old black placeholder must be readable and
  // decodable. Never conceal a missing object or corrupt existing camera file.
  let camera: ReactionVideoProbe | null = null;
  if (input.cameraPath) {
    try { camera = await validatePlayable(path.resolve(input.cameraPath)); }
    catch { throw new Error('REACTION_GENERATOR_CAMERA_INVALID'); }
  }
  const desktop = await validatePlayable(path.resolve(input.desktopPath));
  const generationWindow = planReactionGeneration(cameraPlaceholderReason ? null : camera!.duration, desktop.duration, input);
  const duration = generationWindow.selectedDurationSeconds;
  const destination = path.resolve(input.outputPath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(destination), '.reaction-generator-'));
  try {
    const specFile = path.join(temporary, 'input.json');
    const officialOutput = path.join(temporary, 'official.mp4');
    const adapter = process.env.REACTION_GENERATOR_ADAPTER || path.resolve(process.cwd(), 'scripts/reaction-generator-cli.py');
    await access(adapter);
    const presentation = await preparePresentation(input, temporary, adapter);
    const cameraPath = cameraPlaceholderReason ? await prepareCameraPlaceholder(temporary, adapter, duration) : path.resolve(input.cameraPath!);
    await writeFile(specFile, JSON.stringify({ ...input, presentation, judgementIncluded: generationWindow.judgementIncluded, cameraPath, desktopPath: path.resolve(input.desktopPath), outputPath: officialOutput, assetsDirectory: temporary, durationSeconds: duration }), { mode: 0o600 });
    const configuredTimeout = Number(process.env.REACTION_GENERATOR_TIMEOUT_SECONDS || 1800);
    const timeout = Number.isFinite(configuredTimeout) ? Math.max(30, Math.min(7200, configuredTimeout)) * 1000 : 1_800_000;
    await run(python, [adapter, specFile], root, timeout);
    const finalOutput = path.join(temporary, 'reaction.mp4');
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', officialOutput, '-t', String(duration), '-c', 'copy', '-movflags', '+faststart', finalOutput]);
    const output = await validatePlayable(finalOutput);
    if (output.width !== 1080 || output.height !== 1920 || output.codec !== 'h264' || Math.abs(output.duration - duration) > 0.25) throw new Error('REACTION_GENERATOR_OUTPUT_INVALID');
    if (input.allowPartial && output.duration > generationWindow.minimumAvailableDurationSeconds + 1e-6) throw new Error('REACTION_GENERATOR_OUTPUT_EXCEEDS_AVAILABLE_VIDEO');
    await rename(finalOutput, destination);
    return { ...output, generationWindow, cameraSource: cameraPlaceholderReason ? 'placeholder' : 'recording', cameraPlaceholderReason,
      cameraTemplateBasis: cameraPlaceholderReason ? 'built-in:reaction-camera-placeholder-v1' : null };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
