import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ContestInfo, OrganizationInfo, ProblemInfo, TeamInfo } from "../../api";

type ContestState = {
    info?: ContestInfo & {
        organizationsById: Record<OrganizationInfo["id"], OrganizationInfo>;
        teamsId: Record<TeamInfo["id"], TeamInfo>;
        problemsId: Record<ProblemInfo["id"], ProblemInfo>;
    };
};

const contestSlice = createSlice({
    name: "contestInfo",
    initialState: {} as ContestState,
    reducers: {
        setInfo(state, { payload }: PayloadAction<ContestInfo>) {
            state.info = {
                ...payload,
                problems: payload.problems.filter(problem => !problem.isHidden).sort((a, b) => a.ordinal - b.ordinal),
                organizationsById: Object.fromEntries(payload.organizations.map(organization => [organization.id, organization])),
                teamsId: Object.fromEntries(payload.teams.map(team => [team.id, team])),
                problemsId: Object.fromEntries(payload.problems.map(problem => [problem.id, problem])),
            };
        },
    },
});

export const { setInfo } = contestSlice.actions;
export const contestInfoReducer = contestSlice.reducer;
