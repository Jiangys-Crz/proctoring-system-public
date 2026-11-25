import { contestInfoReducer } from "./contest/contestInfo";
import { queueReducer } from "./contest/queue";
import scoreboardReducer from "./contest/scoreboard";
import debugReducer from "./debug";
import statusReducer from "./status";
import { widgetsReducer } from "./widgets";
import { tickerReducer } from "./ticker";
import statisticsReducer from "./contest/statistics";
import type { TimeLineRunInfo } from "../api";
import { configureStore, createSlice, type PayloadAction } from "@reduxjs/toolkit";



const timelineSlice = createSlice({
    name: "timeline",
    initialState: {} as Record<string, TimeLineRunInfo[]>,
    reducers: {
        setTimeline: (_state, action: PayloadAction<Record<string, TimeLineRunInfo[]>>) => action.payload,
    },
});

export const { setTimeline } = timelineSlice.actions;

export const createOverlayStore = () => configureStore({
    reducer: {
        widgets: widgetsReducer,
        status: statusReducer,
        debug: debugReducer,
        queue: queueReducer,
        scoreboard: scoreboardReducer,
        contestInfo: contestInfoReducer,
        ticker: tickerReducer,
        statistics: statisticsReducer,
        timeline: timelineSlice.reducer,
    },
    middleware: (getDefaultMiddleware) => {
        return getDefaultMiddleware({
            immutableCheck: false,
            serializableCheck: false,
        });
    },
    devTools: process.env.NODE_ENV === "development",
});


export type OverlayStore = ReturnType<typeof createOverlayStore>;
export type RootState = ReturnType<OverlayStore["getState"]>;

export type AppDispatch = OverlayStore["dispatch"];
