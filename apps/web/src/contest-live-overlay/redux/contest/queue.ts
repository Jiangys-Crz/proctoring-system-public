import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { QueueRunInfo } from "../../api";

const initialState: { queue: QueueRunInfo[]; totalQueueItems: number } = {
    queue: [],
    totalQueueItems: 0,
};

const queueSlice = createSlice({
    name: "queue",
    initialState,
    reducers: {
        setFromSnapshot(state, action: PayloadAction<QueueRunInfo[]>) {
            const previousIds = new Set(state.queue.map(run => run.id));
            state.totalQueueItems += action.payload.filter(run => !previousIds.has(run.id)).length;
            state.queue = action.payload;
        },
    },
});

export const { setFromSnapshot } = queueSlice.actions;
export const queueReducer = queueSlice.reducer;
