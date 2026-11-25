import type { CSSProperties } from "react";
import type { TransitionStatus } from "react-transition-state";
import type { Keyframes } from "styled-components";
import { rowExpand, fadeOut } from "./animations";

export const queueRowContractionStates = (fullHeight: number): Partial<Record<TransitionStatus, { animation?: Keyframes; style?: CSSProperties }>> => ({
    entering: {
        animation: rowExpand(fullHeight),
        style: { alignItems: "flex-start" },
    },
    entered: {},
    exiting: {
        animation: fadeOut(),
    },
    exited: {},
});
