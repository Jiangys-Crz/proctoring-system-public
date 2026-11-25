import React from "react";
import { TextWrap } from "./Text";
import ContestClock from "../../molecules/Clock";
import { ClockType, type TickerMessageSettings, type TickerPart } from "../../../api";

export const Clock = ({ tickerSettings, part }: { tickerSettings: TickerMessageSettings.clock; part: TickerPart }) => {
    return (
        <TextWrap part={part}>
            <ContestClock
                clockType={tickerSettings.clockType ?? ClockType.standard}
                showSeconds={tickerSettings.showSeconds ?? true}
                timeZone={tickerSettings.timeZone ?? null}
            />
        </TextWrap>
    );
};

export default Clock;
