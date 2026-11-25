import type { CSSProperties, ReactNode } from 'react';
import type { ContestDisplayResponse } from '@/lib/contest-display-contract';
import type { ContestLiveBroadcastTeam } from '@/lib/contest-live-settings';
import styles from './GraphicSlides.module.css';

type GraphicScene = 'logo' | 'logoA' | 'logoB' | 'imageProgression' | 'promotions' | 'ccs' | 'message' | 'title';
const builtInLogo = '/brand/logo.png';
const scenes: Record<GraphicScene, string> = {
  logo: 'Logo', logoA: 'Logo A', logoB: 'Logo B', imageProgression: 'Image progression',
  promotions: 'Promotions', ccs: 'CCS', message: 'Message', title: 'Title',
};

function PresentationImage({ src, alt = '', className, style }: {
  src: string; alt?: string; className?: string; style?: CSSProperties;
}) {
  return <img src={src} alt={alt} className={className} style={style} referrerPolicy="no-referrer"
    onLoad={event => {
      const img = event.currentTarget;
      if (img.naturalHeight) img.style.setProperty('--asset-aspect', String(img.naturalWidth / img.naturalHeight));
    }} />;
}

export function GraphicHelp({ children }: { children: ReactNode }) {
  return <div className={styles.help}>{children}</div>;
}

function BuildImages({ images, elapsed }: { images: string[]; elapsed: number }) {
  if (!images.length) return <GraphicHelp>Add images for this presentation in the display settings.</GraphicHelp>;
  const entryDelay = 800;
  const stageDuration = 800;
  const finalHold = 10_000;
  const exitDuration = 1_000;
  const buildup = stageDuration * images.length;
  const cycle = entryDelay + buildup + finalHold + exitDuration;
  const cycleTime = elapsed % cycle;
  if (cycleTime < entryDelay) return <PresentationImage src={images[0]} className={styles.preload} />;
  const playTime = cycleTime - entryDelay;
  const index = Math.min(images.length - 1, Math.floor(playTime / stageDuration));
  const fadingIn = playTime < buildup;
  const opacity = fadingIn ? (playTime % stageDuration) / stageDuration
    : 1 - Math.max(0, playTime - buildup - finalHold) / exitDuration;
  const scale = .94 + .06 * cycleTime / cycle;
  return <div className={styles.imageBuild} style={{ transform: `scale(${scale})` }}>
    {fadingIn && index > 0 && <PresentationImage src={images[index - 1]} />}
    <PresentationImage src={images[index]} style={{ opacity }} />
    {fadingIn && images[index + 1] && <PresentationImage src={images[index + 1]} className={styles.preload} />}
  </div>;
}

function ContestLogo({ data }: { data: ContestDisplayResponse }) {
  const { settings, contest } = data;
  return <PresentationImage className={styles.contestLogo}
    src={settings.presentationAssets?.logo || builtInLogo} alt={settings.title || contest.exam.name} />;
}

export function ContestBanner({ data, className }: { data: ContestDisplayResponse; className?: string }) {
  const { settings, contest } = data;
  const assets = settings.presentationAssets;
  return assets?.banner
    ? <PresentationImage className={className} src={assets.banner} alt={settings.title || contest.exam.name} />
    : <div className={`${styles.fallbackBanner} ${className ?? ''}`}>
      <PresentationImage src={assets?.logo || builtInLogo} />
      <span>{settings.title || contest.exam.name}</span>
    </div>;
}

function MessageText({ message, data }: { message: string; data: ContestDisplayResponse }) {
  const { teams, problems, exam } = data.contest;
  const references = /\{(teams|organizations|problems|submissions):([^{}]+)\}|\{(contest)\}/g;
  const segments: ReactNode[] = [];
  let index = 0;
  for (const match of message.matchAll(references)) {
    const { 1: type, 2: id, 3: singleton, index: start } = match;
    segments.push(message.slice(index, start));
    index = start + match[0].length;
    if (singleton === 'contest') segments.push(exam.name);
    if (type === 'teams' || type === 'organizations') {
      const team = type === 'teams' ? teams.find((team, i) => team.id === id || String(i + 1) === id)
        : teams.find(team => team.organization === id);
      segments.push(team ? <span className={styles.inlineTeam} key={start}>
        {team.organizationLogoUrl && <PresentationImage src={team.organizationLogoUrl} />}
        {type === 'teams' ? team.name : team.organization}
      </span> : type === 'teams' ? '[missing team]' : '[missing organization]');
    }
    if (type === 'problems') {
      const problem = problems.find(problem => problem.id === id || problem.label === id);
      segments.push(problem ? <span className={styles.inlineProblem} key={start}
        style={{ '--badge-color': problem.color || '#777' } as CSSProperties}>{problem.label}</span> : '[missing problem]');
    }
    if (type === 'submissions') {
      const run = data.contest.submissions.find(run => run.id === id);
      segments.push(run ? <span className={styles.inlineProblem} key={start}
        style={{ '--badge-color': run.frozen ? 'var(--frozen)' : '#f6d900' } as CSSProperties}>{id}</span> : '[missing submission]');
    }
  }
  segments.push(message.slice(index));
  return segments;
}

export function TeamDetailSlide({ team, data }: { team?: ContestLiveBroadcastTeam; data: ContestDisplayResponse }) {
  const label = team && data.contest.teams.findIndex(candidate => candidate.id === team.id) + 1;
  return <section className={styles.centered} aria-label="Team Detail">
    {!team ? <ContestLogo data={data} /> : <>
      {team.photoUrl ? <div className={styles.teamPhoto}>
        <PresentationImage className={styles.teamPortrait} src={team.photoUrl} alt={team.name} />
        {team.organizationLogoUrl && <PresentationImage className={styles.photoLogo} src={team.organizationLogoUrl} />}
      </div> : team.organizationLogoUrl && <PresentationImage className={styles.teamLogo} src={team.organizationLogoUrl} alt={team.organization} />}
      <strong className={styles.teamLabel}>{label} – {team.name}</strong>
    </>}
  </section>;
}

export function CaptionPhotoSlide({ photo, caption }: { photo?: ContestLiveBroadcastTeam; caption: string }) {
  return <section className={styles.centered} aria-label="Photo and Caption">
    {photo?.photoUrl ? <PresentationImage className={styles.fullImage} src={photo.photoUrl} alt={photo.name} />
      : <GraphicHelp>Upload a team photo to display it with a caption.</GraphicHelp>}
    {caption && <strong className={styles.photoCaption}>{caption}</strong>}
  </section>;
}

export function GraphicSlide({ scene, data, elapsed }: { scene: GraphicScene; data: ContestDisplayResponse; elapsed: number }) {
  const { settings, contest } = data;
  const assets = settings.presentationAssets;
  const title = settings.title || contest.exam.name;
  const caption = scenes[scene];
  const time = elapsed * settings.speed;

  switch (scene) {
    case 'logo':
      return <section className={styles.centered} aria-label={caption}><ContestLogo data={data} /></section>;
    case 'message':
      return <section className={styles.message} aria-label={caption}>
        {assets?.background && <PresentationImage src={assets.background} className={styles.messageBackground} />}
        <div className={styles.messageContent}>
          {settings.message && <h1><MessageText message={settings.message} data={data} /></h1>}
        </div>
        {!assets?.background && <ContestBanner className={styles.messageBanner} data={data} />}
      </section>;
    case 'title':
      return <section className={styles.title} aria-label={caption}>
        <h1>{title}</h1>{settings.message && <p>{settings.message}</p>}
      </section>;
    case 'logoA':
    case 'logoB':
    case 'imageProgression':
      return <section className={styles.centered} aria-label={caption}><BuildImages images={assets?.[scene] ?? []} elapsed={time} /></section>;
    case 'promotions': {
      const images = assets?.promotions ?? [];
      const image = images[Math.floor(time / 6_000) % images.length];
      return <section className={styles.centered} aria-label={caption}>
        {image ? <PresentationImage className={styles.fullImage} src={image} />
          : <GraphicHelp>Add promotional images in the display settings.</GraphicHelp>}
      </section>;
    }
    case 'ccs':
      return <section className={styles.ccs} data-shadow={!!assets?.ccsShadow || undefined} aria-label={caption}>
        {assets?.ccsPrimary ? <>
          <div><PresentationImage src={assets.ccsPrimary} /><span>Contest Control System</span></div>
          {assets.ccsShadow && <div><PresentationImage src={assets.ccsShadow} /><span>Shadow Verification</span></div>}
        </> : <GraphicHelp>Add the primary CCS logo and an optional shadow logo in the display settings.</GraphicHelp>}
      </section>;
  }
}
