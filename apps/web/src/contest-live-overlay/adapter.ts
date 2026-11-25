import type { ContestLiveBroadcastTeam, ContestLiveResponse, ContestLiveSettings, ContestLiveTeamSlot, ContestLiveTickerMessage } from "@/lib/contest-live-settings";
import type { ContestLiveSubmission } from "@/lib/contest-live-contract";
import { hydroStatusText } from "@/lib/hydro-status";
import {
    ClockType, ContestResultType, ContestStatus, FtsMode, MediaType, OptimismLevel,
    PenaltyRoundingMode, ProblemColorPolicy, ProblemResult, RunResult, ScoreMergeMode,
    ScoreboardScrollDirection, SolutionsStatistic, TeamMediaType, TeamViewPosition,
    TickerMessageSettings, TickerPart, TimeLineRunInfo, Widget,
    type ContestInfo, type OrderedTickerMessage, type OrderedWidget, type QueueRunInfo, type ScoreboardDiff,
} from "./api";

type LiveContest = ContestLiveResponse["contest"];

const groupId = (name: string) => `group:${name}`;
const organizationId = (name: string) => `organization:${name}`;
const accepted = (verdict: string) => /^(AC|OK|Accepted|通过|正确)$/i.test(verdict.trim());
const verdictShortNames = new Map([
    ["Wrong Answer", "WA"], ["Time Limit Exceeded", "TLE"], ["Memory Limit Exceeded", "MLE"],
    ["Output Limit Exceeded", "OLE"], ["Runtime Error", "RTE"], ["Compile Error", "CE"],
    ["Presentation Error", "PE"], ["System Error", "SE"],
]);

function contestStatus(exam: LiveContest["exam"], start: number, end: number, now: number): ContestStatus {
    if (exam.beforeStart) return { type: ContestStatus.Type.before, scheduledStartAtUnixMs: start };
    const frozenAtUnixMs = exam.frozen && exam.freezeAt ? Date.parse(exam.freezeAt) : null;
    if (now >= end) return { type: ContestStatus.Type.over, startedAtUnixMs: start, finishAtUnixMs: end, frozenAtUnixMs };
    return { type: ContestStatus.Type.running, startedAtUnixMs: start, frozenAtUnixMs };
}

const image = (url: string | null): MediaType[] => url ? [{ type: MediaType.Type.Image, url }] : [];
const video = (url: string | null): MediaType[] => url ? [{ type: MediaType.Type.ProctorWebRTC, url }] : [];

function selectedMedia(team: ContestLiveBroadcastTeam, mode: ContestLiveSettings["mediaMode"]) {
    const screen = video(team.media.screenUrl);
    const camera = video(team.media.cameraUrl);
    const photo = image(team.photoUrl);
    switch (mode) {
        case "screen": return { primary: screen, secondary: [] };
        case "camera": return { primary: camera, secondary: [] };
        case "photo": return { primary: photo, secondary: [] };
        case "both": return screen.length ? { primary: screen, secondary: camera } : { primary: camera, secondary: [] };
        default: return screen.length
            ? { primary: screen, secondary: camera }
            : { primary: camera.length ? camera : photo, secondary: [] };
    }
}

function selectedSlotMedia(team: ContestLiveBroadcastTeam, { primary: first, secondary: second }: ContestLiveTeamSlot) {
    const primary = first === "empty" ? [] : selectedMedia(team, first).primary;
    const secondary = second === "empty" ? [] : selectedMedia(team, second).primary;
    return { primary, secondary: primary[0]?.url === secondary[0]?.url ? [] : secondary };
}

function contestInfo({ exam, problems, teams }: LiveContest, now: number): ContestInfo {
    const start = Date.parse(exam.startAt);
    const end = Date.parse(exam.endAt);
    const isIcpc = exam.scoring === "icpc";
    const groups = [...new Set(teams.map(team => team.group).filter(Boolean))];
    const organizations = new Map<string, string | null>();
    for (const team of teams) {
        if (team.organization && !organizations.get(team.organization)) organizations.set(team.organization, team.organizationLogoUrl);
    }
    return {
        name: exam.name,
        status: contestStatus(exam, start, end, now),
        resultType: isIcpc ? ContestResultType.ICPC : ContestResultType.IOI,
        contestLengthMs: Math.max(1, end - start),
        freezeTimeMs: exam.freezeAt ? Math.max(0, Date.parse(exam.freezeAt) - start) : null,
        problems: problems.map((problem, ordinal) => ({
            id: problem.id, letter: problem.label, name: problem.name, color: problem.color,
            ordinal, minScore: 0, maxScore: problem.maxScore, weight: 1, isHidden: false,
            scoreMergeMode: isIcpc ? null : ScoreMergeMode.MAX_TOTAL, ftsMode: { type: FtsMode.Type.auto },
        })),
        teams: teams.map(team => ({
            id: team.id, name: team.name, shortName: team.name, groups: team.group ? [groupId(team.group)] : [],
            hashTag: null, isHidden: false, isOutOfContest: team.isOutOfContest,
            organizationId: team.organization ? organizationId(team.organization) : null,
            medias: Object.fromEntries(Object.values(TeamMediaType).map(type => [type, [] as MediaType[]])) as Record<TeamMediaType, MediaType[]>,
            customFields: {}, reactionVideoTemplate: null, sourceTemplate: null,
        })),
        groups: groups.map(name => ({ id: groupId(name), displayName: name, isHidden: false, isOutOfContest: false })),
        organizations: [...organizations].map(([name, url]) => ({ id: organizationId(name), displayName: name, fullName: name, logo: image(url), customFields: {} })),
        languages: [], penaltyRoundingMode: PenaltyRoundingMode.sum_down_to_minute, emulationSpeed: 1,
        awardsSettings: [], penaltyPerWrongAttemptSeconds: 1200, queueSettings: {},
        showTeamsWithoutSubmissions: true, problemColorPolicy: { type: ProblemColorPolicy.Type.always },
        customFields: {}, persons: [], accounts: [],
    };
}

function standingsData({ standings, exam }: LiveContest): ScoreboardDiff {
    const isIcpc = exam.scoring === "icpc";
    const medals = { Gold: "Gold medal", Silver: "Silver medal", Bronze: "Bronze medal" };
    return {
        order: standings.map(row => row.teamId),
        ranks: standings.map(row => row.rank ?? 0),
        awards: (Object.keys(medals) as Array<keyof typeof medals>).map(medal => ({
            id: `${medal.toLowerCase()}-medal`, citation: medals[medal],
            teams: standings.filter(row => row.medal === medal).map(row => row.teamId),
        })).filter(award => award.teams.length > 0),
        rows: Object.fromEntries(standings.map(row => [row.teamId, {
            totalScore: isIcpc ? row.solved : row.score,
            penalty: row.penaltySeconds,
            lastAcceptedMs: Math.max(0, ...row.cells.filter(cell => cell.accepted).map(cell => cell.seconds)) * 1000,
            problemResults: row.cells.map((cell): ProblemResult => {
                const lastSubmitTimeMs = cell.accepted || cell.wrong || cell.pending || cell.score !== null ? cell.seconds * 1000 : null;
                return isIcpc ? {
                    type: ProblemResult.Type.ICPC,
                    wrongAttempts: cell.wrong, pendingAttempts: cell.pending, isSolved: cell.accepted,
                    isFirstToSolve: cell.firstBlood, lastSubmitTimeMs, frozen: cell.frozen,
                } : {
                    type: ProblemResult.Type.IOI,
                    score: cell.score, pendingAttempts: cell.pending,
                    lastSubmitTimeMs, isFirstBest: cell.firstBlood, frozen: cell.frozen,
                    totalAttempts: cell.wrong + cell.pending + Number(cell.accepted),
                };
            }),
        }])),
    };
}

function verdictData(verdict: string) {
    const normalized = hydroStatusText(verdict);
    const isAccepted = accepted(normalized);
    const shortName = isAccepted ? "AC" : verdictShortNames.get(normalized)
        ?? (/^[A-Z]{2,4}$/i.test(normalized) ? normalized.toUpperCase() : "??");
    return { shortName, isAddingPenalty: !isAccepted, isAccepted };
}

function submissionsData({ submissions, timeline: teamRuns, exam, teams }: LiveContest, { analytics, mediaMode }: ContestLiveSettings) {
    const teamsById = new Map(teams.map(team => [team.id, team]));
    const isIcpc = exam.scoring === "icpc";
    const timeline: Record<string, TimeLineRunInfo[]> = {};
    const queue = submissions.map((run): QueueRunInfo => {
        const verdict = !run.frozen && run.verdict ? verdictData(run.verdict) : null;
        const result: RunResult = !verdict
            ? { type: RunResult.Type.IN_PROGRESS, testedPart: run.frozen ? undefined : run.testedPart, isAfterFirstOk: false, frozen: run.frozen }
            : isIcpc
                ? { type: RunResult.Type.ICPC, verdict, isFirstToSolveRun: run.firstBlood, isAfterFirstOk: false }
                : { type: RunResult.Type.IOI, score: [run.score ?? 0], wrongVerdict: null,
                    difference: 0, scoreAfter: run.score ?? 0, isFirstBestRun: run.firstBlood, isFirstBestTeamRun: run.firstBlood };
        const featured = analytics.visible && analytics.submissionId === run.id;
        const team = teamsById.get(run.teamId);
        return {
            id: run.id, teamId: run.teamId, problemId: run.problemId, result, reactionVideos: [],
            featuredRunMedia: featured && team ? selectedMedia(team, mediaMode).primary : null,
            featuredCaption: featured ? analytics.annotation : undefined,
            isFeaturedRun: featured,
        };
    });
    for (const run of teamRuns) {
        const point = (): TimeLineRunInfo => {
            const timing = { time: run.seconds * 1000, problemId: run.problemId };
            if (run.frozen || !run.verdict) return { type: TimeLineRunInfo.Type.IN_PROGRESS, frozen: run.frozen, ...timing };
            if (!isIcpc) return { type: TimeLineRunInfo.Type.IOI, score: run.score ?? 0, ...timing };
            const { isAccepted, shortName } = verdictData(run.verdict);
            return { type: TimeLineRunInfo.Type.ICPC, isAccepted, shortName, ...timing };
        };
        (timeline[run.teamId] ??= []).push(point());
    }
    return { queue, timeline };
}

function statisticData({ exam, problems, statistics, standings, teams }: LiveContest): SolutionsStatistic {
    const rowsByProblem = new Map(problems.map(problem => [problem.id, {
        success: 0, wrong: 0, pending: 0, scores: new Map<number, number>(),
    }]));
    for (const row of standings) {
        for (const cell of row.cells) {
            const counts = rowsByProblem.get(cell.problemId);
            if (!counts) continue;
            if (cell.accepted) counts.success++;
            else if (cell.pending > 0) counts.pending++;
            else if (cell.wrong > 0) counts.wrong++;
            if (cell.score !== null) counts.scores.set(cell.score, (counts.scores.get(cell.score) ?? 0) + 1);
        }
    }
    if (exam.scoring === "icpc") {
        const byProblem = new Map(statistics.map(row => [row.problemId, row]));
        return { type: SolutionsStatistic.Type.ICPC, teamsCount: teams.length, stats: problems.map(problem => {
            const row = byProblem.get(problem.id);
            return { success: row?.teamsAccepted ?? 0, wrong: row?.teamsRejected ?? 0, pending: row?.teamsPending ?? 0 };
        }) };
    }
    return { type: SolutionsStatistic.Type.IOI, teamsCount: teams.length, stats: [...rowsByProblem.values()]
        .map(({ scores, pending }) => ({ pending, result: [...scores].sort(([a], [b]) => b - a)
            .map(([score, count]) => ({ score, count })) })) };
}

function clockSettings(clock: ContestLiveSettings["clock"]) {
    return { clockType: ClockType[clock.mode], showSeconds: clock.showSeconds, timeZone: clock.timezone };
}

const viewLocations = {
    [TeamViewPosition.SINGLE]: "teamViewSingle",
    [TeamViewPosition.PVP_TOP]: "teamViewPvpTop",
    [TeamViewPosition.PVP_BOTTOM]: "teamViewPvpBottom",
    [TeamViewPosition.TOP_LEFT]: "teamViewTopLeft",
    [TeamViewPosition.TOP_RIGHT]: "teamViewTopRight",
    [TeamViewPosition.BOTTOM_LEFT]: "teamViewBottomLeft",
    [TeamViewPosition.BOTTOM_RIGHT]: "teamViewBottomRight",
} satisfies Record<TeamViewPosition, string>;

function widgetData({ settings, contest }: ContestLiveResponse): OrderedWidget[] {
    const result: OrderedWidget[] = [];
    const position = (id: string, location = id) => ({ widgetId: id, statisticsId: id, widgetLocationId: location });
    const append = (widget: Widget) => result.push({ widget, showOrder: result.length });
    const { scoreboard, widgets, clock, titles, teamMode, selectedTeamIds, teamSlots, spotlight, mediaMode } = settings;
    const teams = new Map(contest.teams.map(team => [team.id, team]));
    const selected = selectedTeamIds
        .map(teamId => teams.get(teamId)).filter((team): team is ContestLiveBroadcastTeam => team !== undefined);
    const teamPositions = teamMode === "pvp" ? [TeamViewPosition.PVP_TOP, TeamViewPosition.PVP_BOTTOM]
        : teamMode === "split" ? [TeamViewPosition.TOP_LEFT, TeamViewPosition.TOP_RIGHT, TeamViewPosition.BOTTOM_LEFT, TeamViewPosition.BOTTOM_RIGHT]
            : [TeamViewPosition.SINGLE];
    const scrollDirection = { down: ScoreboardScrollDirection.Forward, up: ScoreboardScrollDirection.Back, off: ScoreboardScrollDirection.Pause };
    if (widgets.clock) append({ type: Widget.Type.FullScreenClockWidget, ...position("fullScreenClock"), settings: clockSettings(clock) });
    if (widgets.scoreboard) append({
        type: Widget.Type.ScoreboardWidget, ...position("scoreboard"),
        settings: { group: scoreboard.group ? groupId(scoreboard.group) : "all", optimismLevel: OptimismLevel[scoreboard.version],
            scrollDirection: scrollDirection[scoreboard.scroll], offset: scoreboard.offset, limit: scoreboard.limit, showProblems: scoreboard.showProblems },
    });
    if (widgets.statistics) append({ type: Widget.Type.StatisticsWidget, ...position("statistics"), settings: {} });
    if ((titles.titleVisible ?? titles.visible) && (titles.title || titles.subtitle)) {
        append({ type: Widget.Type.AdvertisementWidget, ...position("title"),
            advertisement: { text: titles.title, subtitle: titles.subtitle } });
    }
    if ((titles.pictureVisible ?? titles.visible) && titles.pictureUrl) {
        append({ type: Widget.Type.PictureWidget, ...position("picture"),
            picture: { url: titles.pictureUrl, name: titles.subtitle || titles.title } });
    }
    if ((titles.advertisementVisible ?? titles.visible) && titles.advertisement) {
        append({ type: Widget.Type.AdvertisementWidget, ...position("advertisement"),
            advertisement: { text: titles.advertisement } });
    }
    if (titles.svgVisible && titles.svgUrl) {
        append({ type: Widget.Type.SvgWidget, ...position("svg"), content: titles.svgUrl });
    }
    if (titles.videoVisible && titles.videoUrl) {
        append({ type: Widget.Type.VideoWidget, ...position("video"), video: { url: titles.videoUrl } });
    }
    for (const [index, viewPosition] of teamPositions.entries()) {
        const slot = teamSlots?.[index];
        const team = teamSlots ? slot && teams.get(slot.teamId) : selected[index];
        if (!team) continue;
        append({ type: Widget.Type.TeamViewWidget, ...position(viewLocations[viewPosition]),
            settings: {
                teamId: team.id, position: viewPosition,
                ...(slot ? selectedSlotMedia(team, slot) : selectedMedia(team, mediaMode)),
                achievement: [], showTaskStatus: slot?.showTaskStatus ?? true,
                showTimeLine: teamMode !== "split" && (slot?.showTimeLine ?? true),
            },
        });
    }
    const spotlit = spotlight.visible ? spotlight.teamIds.filter(id => teams.has(id)).slice(0, 8) : [];
    if (spotlit.length) append({ type: Widget.Type.SpotlightWidget, ...position("spotlight"), teamIds: spotlit });
    if (widgets.queue) append({ type: Widget.Type.QueueWidget, ...position("queue", settings.horizontalQueue ? "queueHorizontal" : "queue"), settings: { horizontal: settings.horizontalQueue } });
    if (widgets.ticker) append({ type: Widget.Type.TickerWidget, ...position("ticker"), settings: {} });
    return result;
}

function tickerSettings({ part, mode, periodMs, clock, imageUrl, text, from, to }: ContestLiveTickerMessage): TickerMessageSettings {
    const shared = { part: TickerPart[part], periodMs };
    switch (mode) {
        case "clock": return { ...shared, type: TickerMessageSettings.Type.clock, ...clockSettings(clock) };
        case "image": return imageUrl
            ? { ...shared, type: TickerMessageSettings.Type.image, path: imageUrl }
            : { ...shared, type: TickerMessageSettings.Type.empty };
        case "scoreboard": return { ...shared, type: TickerMessageSettings.Type.scoreboard, from, to };
        case "text": return { ...shared, type: TickerMessageSettings.Type.text, text };
    }
}

function tickerData({ settings, contest }: ContestLiveResponse): OrderedTickerMessage[] {
    const { ticker, clock } = settings;
    if (ticker.messages) return ticker.messages.filter(message => message.shown).map((message, showOrder) => {
        const content = tickerSettings(message);
        return { showOrder, message: { id: `${message.id}:${JSON.stringify(content)}`, settings: content } };
    });
    const periodMs = ticker.speed * 1000;
    let long: TickerMessageSettings;
    const part = TickerPart.long;
    switch (ticker.mode) {
        case "clock": long = { type: TickerMessageSettings.Type.clock, part, periodMs, ...clockSettings(clock) }; break;
        case "image": long = ticker.imageUrl
            ? { type: TickerMessageSettings.Type.image, part, periodMs, path: ticker.imageUrl }
            : { type: TickerMessageSettings.Type.empty, part, periodMs }; break;
        case "scoreboard": long = { type: TickerMessageSettings.Type.scoreboard, part, periodMs, from: 1,
            to: Math.max(1, Math.min(settings.scoreboard.limit, contest.standings.length)) }; break;
        default: long = { type: TickerMessageSettings.Type.text, part, periodMs, text: ticker.text || contest.exam.name };
    }
    return [
        { showOrder: 0, message: { id: `ticker-clock:${JSON.stringify(clock)}`, settings: { type: TickerMessageSettings.Type.clock, part: TickerPart.short,
            periodMs, ...clockSettings(clock) } } },
        { showOrder: 1, message: { id: `ticker-content:${JSON.stringify(long)}`, settings: long } },
    ];
}

export function makeOverlaySnapshot(response: ContestLiveResponse, now = Date.now(), scoreboardOnly = false,
    queue: ContestLiveSubmission[] = response.contest.submissions) {
    const widgets: OrderedWidget[] = scoreboardOnly ? [{
        showOrder: 0,
        widget: {
            type: Widget.Type.ScoreboardWidget, widgetId: "scoreboard", statisticsId: "scoreboard", widgetLocationId: "scoreboardFullScreen",
            settings: { group: "all", optimismLevel: OptimismLevel.normal, scrollDirection: ScoreboardScrollDirection.Forward,
                offset: 0, showProblems: true },
        },
    }] : widgetData(response);
    return {
        contestInfo: contestInfo(response.contest, now),
        standings: standingsData(response.contest),
        scoreboardVersion: scoreboardOnly ? OptimismLevel.normal : OptimismLevel[response.settings.scoreboard.version],
        ...submissionsData({ ...response.contest, submissions: queue }, response.settings),
        statistics: statisticData(response.contest),
        widgets,
        ticker: scoreboardOnly ? [] : tickerData(response),
    };
}
