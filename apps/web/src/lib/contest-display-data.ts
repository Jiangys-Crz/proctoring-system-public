import { AuthError } from './auth';
import { isContestDisplayChartScene, type ContestDisplayControlState, type ContestDisplayResponse, type ContestDisplaySettings } from './contest-display-contract';
import { readContestDisplayConfig, type ContestDisplayViewer } from './contest-display-config';
import { availableContestDisplayHistory, buildContestDisplayHistory, contestFirstSolution } from './contest-display-history';
import { contestLiveOrganizationLogos } from './contest-live-branding';
import { contestLivePhotoAccountHash } from './contest-live-broadcast';
import { contestLiveSourceUnchanged, readContestLiveData } from './contest-live-data';
import { signContestDisplayHistoryLogo } from './contest-live-media-token';
import { prisma } from './db';
import { normalizeReactionOrganizationName } from './reaction-branding-contract';

type Config = Awaited<ReturnType<typeof readContestDisplayConfig>>;

export async function readContestDisplayContent(examId: string, config: Config) {
  const { settings } = config;
  const scenes = settings.autoplay && settings.playlist.length ? settings.playlist : [settings.scene];
  const timelineTeams = [settings.teamId, ...(settings.autoplay ? (settings.playlistOptions ?? []).map(step => step?.properties?.teamId) : [])]
    .filter((teamId): teamId is string => typeof teamId === 'string');
  const historicalChart = scenes.includes('historicalComparisonChart');
  const firstSolution = scenes.includes('firstToSolve');
  const fullTimeline = scenes.includes('scoreboardTimeline');
  const live = await readContestLiveData(examId, fullTimeline || historicalChart || firstSolution ? 'all' : timelineTeams,
    'normal', settings.freeze, [...new Set(scenes.filter(isContestDisplayChartScene))]);
  if (!live) throw new AuthError('该考试暂无大屏数据', 404);
  const { displayCharts: charts, ...data } = live.data;
  const hashes = new Set(data.teams.flatMap(team => team.accounts.map(contestLivePhotoAccountHash)));
  const archived = (historicalChart || firstSolution) ? await availableContestDisplayHistory(examId, settings.historyExamIds ?? []) : [];
  const [photoRecords, previous] = await Promise.all([
    hashes.size ? prisma.contestLivePhoto.findMany({ where: { examId, accountHash: { in: [...hashes] } },
      select: { id: true, accountHash: true, updatedAt: true } }) : [],
    Promise.all(archived.map(async contest => {
      try {
        const archive = await readContestDisplayConfig(contest.id);
        const history = await readContestLiveData(contest.id, 'all', 'normal', archive.settings.freeze.at ? archive.settings.freeze : undefined);
        return history && !history.data.sourceError && !history.data.exam.frozen ? {
          contest, data: history.data, rosterRevision: history.sourceRevision, configRevision: archive.revision,
        } : null;
      } catch { return null; }
    })),
  ]);
  const past = previous.filter(item => item !== null);
  if (historicalChart && charts && past.length) charts.history = buildContestDisplayHistory(data, past, settings.freeze.at);
  const firstSolutionHistory = firstSolution ? { current: contestFirstSolution(data), past: past.flatMap(item => {
    const first = contestFirstSolution(item.data);
    const team = item.data.teams.find(team => team.id === first?.teamId);
    return first && team ? [{ archiveId: item.contest.id, contestLabel: item.contest.name, teamName: team.name, organization: team.organization, seconds: first.seconds }] : [];
  }) } : undefined;
  if (!fullTimeline && (historicalChart || firstSolution)) {
    const byTeam = new Map(timelineTeams.map(id => [id, [] as typeof data.timeline]));
    for (const run of data.timeline) byTeam.get(run.teamId)?.push(run);
    data.timeline = [...byTeam.values()].flatMap(runs => runs.slice(-500));
  }
  const logos = await contestLiveOrganizationLogos([...data.teams.map(team => team.organization), ...(firstSolutionHistory?.past ?? []).map(item => item.organization)]);
  return { data, charts, firstSolutionHistory, logos, photos: new Map(photoRecords.map(photo => [photo.accountHash, photo])),
    rosterRevision: live.sourceRevision,
    archives: past.map(({ contest, rosterRevision, configRevision }) => ({ id: contest.id, rosterRevision, configRevision })),
  };
}

type Content = Awaited<ReturnType<typeof readContestDisplayContent>>;

export async function contestDisplaySourcesUnchanged(examId: string, content: Content) {
  const unchanged = await Promise.all([
    contestLiveSourceUnchanged(examId, content.rosterRevision),
    ...content.archives.map(async archive => {
      try {
        const [config, rosterUnchanged] = await Promise.all([
          readContestDisplayConfig(archive.id), contestLiveSourceUnchanged(archive.id, archive.rosterRevision),
        ]);
        return rosterUnchanged && config.revision === archive.configRevision;
      } catch { return false; }
    }),
  ]);
  return unchanged.every(Boolean);
}

function displayStandings(data: Content['data'], { gold, silver, bronze }: ContestDisplaySettings['medals']) {
  const awardsReady = !data.exam.frozen && !data.sourceError && Date.now() >= Date.parse(data.exam.endAt);
  return data.standings.map(row => {
    let medal = awardsReady ? row.medal : null;
    if (awardsReady && row.rank !== null && gold + silver + bronze > 0) {
      medal = row.rank <= gold ? 'Gold' : row.rank <= gold + silver ? 'Silver' : row.rank <= gold + silver + bronze ? 'Bronze' : null;
    }
    return { ...row, medal };
  });
}

export function contestDisplayControlState(config: Config, manage: boolean): ContestDisplayControlState {
  const { savedPlans: _savedPlans, historyExamIds: _historyExamIds, ...playback } = config.settings;
  return { settings: manage ? config.settings : playback, revision: config.revision, startedAt: config.startedAt?.toISOString() ?? null,
    serverTime: Date.now(), keyActive: manage && !!config.keyHash };
}

export function contestDisplayResponse(config: Config, content: Content, viewer: ContestDisplayViewer): ContestDisplayResponse {
  const { data, charts, firstSolutionHistory, logos, photos } = content;
  const base = `/api/exams/${encodeURIComponent(data.exam.id)}/contest-display/assets`;
  function assetUrl(kind: string, id: string, params: Record<string, string>) {
    const query = new URLSearchParams(params);
    if (viewer.key) query.set('key', viewer.key);
    return `${base}/${kind}/${encodeURIComponent(id)}?${query}`;
  }
  return {
    ...contestDisplayControlState(config, viewer.manage),
    ...(charts && { charts }),
    ...(firstSolutionHistory && { firstSolutionHistory: {
      current: firstSolutionHistory.current,
      past: firstSolutionHistory.past.map(({ organization, archiveId, ...result }) => {
        const school = normalizeReactionOrganizationName(organization);
        const logo = logos.get(school);
        return { ...result, logoUrl: logo ? assetUrl('history-logo', logo.id, { school, archive: archiveId,
          grant: signContestDisplayHistoryLogo(data.exam.id, archiveId, config.revision, school, logo.id) }) : null };
      }),
    } }),
    contest: {
      ...data,
      standings: displayStandings(data, config.settings.medals),
      sourceError: viewer.manage ? data.sourceError : data.sourceError ? '赛事数据同步暂时中断' : null,
      teams: data.teams.map(team => {
        const school = normalizeReactionOrganizationName(team.organization);
        const logo = logos.get(school);
        const photo = team.accounts.map(account => photos.get(contestLivePhotoAccountHash(account))).find(Boolean);
        return {
          ...team,
          ...(viewer.manage ? {} : { account: '', accounts: [], candidateIds: [] }),
          organizationLogoUrl: logo ? assetUrl('logo', logo.id, { school }) : null,
          photoUrl: photo ? assetUrl('photo', photo.id, { team: team.id, v: String(+photo.updatedAt) }) : null,
          media: { screenUrl: null, cameraUrl: null },
        };
      }),
    },
  };
}
