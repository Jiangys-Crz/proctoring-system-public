import { useMemo } from "react";
import { useAppSelector } from "../../../../../redux/hooks";
import { ContestInfo, OptimismLevel, ProblemInfo, TeamInfo } from "../../../../../api";
import { ScoreboardData } from "../../../../../redux/contest/scoreboard";

export function useScoreboardRows(
    optimismLevel: OptimismLevel = OptimismLevel.normal,
    selectedGroup = "all",
    offset = 0,
) {
    const order = useAppSelector(
        (state) => state.scoreboard[optimismLevel]?.orderById,
    );
    const teamsId = useAppSelector((state) => state.contestInfo.info?.teamsId);

    return useMemo(() => {
        if (teamsId === undefined || order === undefined) {
            return [];
        }

        return Object.entries(order)
            .filter(([teamId]) => selectedGroup === "all" || teamsId[teamId]?.groups.includes(selectedGroup))
            .sort(([, left], [, right]) => left - right)
            .slice(offset)
            .map(([teamId], index): [string, number] => [teamId, index]);
    }, [order, teamsId, selectedGroup, offset]);
}

export function useScoreboardData(optimismLevel: OptimismLevel = OptimismLevel.normal): {
    scoreboardData: ScoreboardData;
    normalScoreboardData: ScoreboardData;
    contestData: (ContestInfo & {
        teamsId: Record<TeamInfo["id"], TeamInfo>;
        problemsId: Record<ProblemInfo["id"], ProblemInfo>;
    }) | undefined;
} {
    const scoreboardData = useAppSelector(
        (state) => state.scoreboard[optimismLevel],
    );
    const normalScoreboardData = useAppSelector(
        (state) => state.scoreboard[OptimismLevel.normal],
    );
    const contestData = useAppSelector((state) => state.contestInfo.info);

    return useMemo(
        () => ({
            scoreboardData,
            normalScoreboardData,
            contestData,
        }),
        [scoreboardData, normalScoreboardData, contestData],
    );
}
