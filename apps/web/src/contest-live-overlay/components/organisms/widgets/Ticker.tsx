import React, { useEffect, useState, useRef } from "react";
import styled, { keyframes, css } from "styled-components";
import c from "../../../config";
import { startScrolling, stopScrolling } from "../../../redux/ticker";
const live = "/contest-live-assets/live.svg";
import Clock from "../tickers/Clock";
import Scoreboard from "../tickers/Scoreboard";
import Text from "../tickers/Text";
import Image from "../tickers/Image";
import Empty from "../tickers/Empty";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { TickerMessage, TickerMessageSettings, TickerPart } from "../../../api";

const rowAppear = keyframes`
  from {
    transform: translate3d(0, -100%, 0);
  }
  to {
    transform: translate3d(0, 0, 0);
  }
`;

const rowDisappear = keyframes`
  from {
    transform: translate3d(0, 0, 0);
  }
  to {
    transform: translate3d(0, 100%, 0);
  }
`;

type AnimationType = ReturnType<typeof keyframes> | null;

const TickerRowContainer = styled.div<{ animation?: AnimationType }>`
    position: absolute;
    top: 0;
    left: 0;

    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;

    width: 100%;
    height: 100%;

    font-family: ${c.TICKER_FONT_FAMILY};

    ${({ animation }) =>
        animation &&
        css`
            animation: ${animation} ${c.TICKER_SCROLL_TRANSITION_TIME}ms
                ease-in-out forwards;
        `}
    will-change: transform;
`;

interface TickerRowProps {
    children: React.ReactNode;
    animation: AnimationType;
}

const TickerRow: React.FC<TickerRowProps> = ({ children, animation }) => {
    return (
        <TickerRowContainer animation={animation}>
            {children}
        </TickerRowContainer>
    );
};

const SingleTickerWrap = styled.div<{
    justify?: string;
    padding?: string;
    color?: string;
}>`
    position: relative;

    display: flex;
    justify-content: ${(props) => props.justify};

    box-sizing: border-box;
    width: 100%;
    height: 100%;
    padding-left: ${(props) => props.padding};

    background-color: ${(props) => props.color};
    border-radius: ${c.GLOBAL_BORDER_RADIUS};
`;

interface TickerMessageState {
    id: string;
    message: TickerMessage;
    status: "entering" | "entered" | "exiting";
}

interface SingleTickerRowsProps {
    part: TickerPart;
}

export const SingleTickerRows: React.FC<SingleTickerRowsProps> = ({ part }) => {
    const curMessage = useAppSelector(
        (state) => state.ticker.tickers[part].curDisplaying,
    );
    const isFirst = useAppSelector(
        (state) => state.ticker.tickers[part].isFirst,
    );

    const [displayMessages, setDisplayMessages] = useState<
        TickerMessageState[]
    >([]);
    const lastMessageId = useRef<string | null>(null);

    useEffect(() => {
        if (!curMessage) {
            // eslint-disable-next-line react-compiler/react-compiler
            setDisplayMessages([]);
            lastMessageId.current = null;
            return;
        }

        if (curMessage.id === lastMessageId.current) {
            return;
        }

        const newMessage: TickerMessageState = {
            id: curMessage.id,
            message: curMessage,
            status: isFirst ? "entered" : "entering",
        };

        setDisplayMessages((prev) => {
            if (isFirst) return [newMessage];
            const next: TickerMessageState[] = prev
                .filter((m) => m.status !== "exiting")
                .map((m) => ({ ...m, status: "exiting" as const }));

            next.push(newMessage);
            return next;
        });

        lastMessageId.current = curMessage.id;

        if (!isFirst) {
            const timer = setTimeout(() => {
                setDisplayMessages((prev) =>
                    prev
                        .map((m) =>
                            m.id === curMessage.id
                                ? { ...m, status: "entered" as const }
                                : m,
                        )
                        .filter((m) => m.status !== "exiting"),
                );
            }, c.TICKER_SCROLL_TRANSITION_TIME);
            return () => clearTimeout(timer);
        }
    }, [curMessage, isFirst]);

    return (
        <>
            {displayMessages.map((m) => {
                const animation =
                    m.status === "entering"
                        ? rowAppear
                        : m.status === "exiting"
                          ? rowDisappear
                          : null;

                return (
                    <TickerRow key={m.id} animation={animation}>
                        <TickerContent settings={m.message.settings} state={m.status} part={part} />
                    </TickerRow>
                );
            })}
        </>
    );
};

function TickerContent({ settings, state, part }: {
    settings: TickerMessageSettings;
    state: TickerMessageState["status"];
    part: TickerPart;
}) {
    switch (settings.type) {
        case TickerMessageSettings.Type.clock: return <Clock tickerSettings={settings} part={part} />;
        case TickerMessageSettings.Type.text: return <Text tickerSettings={settings} part={part} />;
        case TickerMessageSettings.Type.image: return <Image tickerSettings={settings} />;
        case TickerMessageSettings.Type.scoreboard: return <Scoreboard tickerSettings={settings} state={state} />;
        default: return <Empty />;
    }
}

const ShortTickerGrid = styled.div`
    display: grid;
    grid-template-columns: ${c.TICKER_LIVE_ICON_SIZE} auto;
    column-gap: ${c.TICKER_SHORT_COLUMN_GAP};

    width: 100%;
    margin: ${c.TICKER_LIVE_ICON_MARGIN};
`;

const LiveIcon = styled.img`
    height: ${c.TICKER_LIVE_ICON_SIZE};
    padding: ${c.TICKER_LIVE_ICON_PADDING};
`;

interface SingleTickerProps {
    part: TickerPart;
    color?: string;
}

export const SingleTicker: React.FC<SingleTickerProps> = ({ part, color }) => {
    const curMessage = useAppSelector(
        (state) => state.ticker.tickers[part].curDisplaying,
    );

    if (part === "short") {
        return (
            <SingleTickerWrap color={color}>
                <ShortTickerGrid>
                    <LiveIcon src={live} />
                    <SingleTickerWrap>
                        <SingleTickerRows part={part} />
                    </SingleTickerWrap>
                </ShortTickerGrid>
            </SingleTickerWrap>
        );
    }

    const wrapColor =
        curMessage?.settings.type === TickerMessageSettings.Type.scoreboard ||
        curMessage?.settings.type === TickerMessageSettings.Type.empty
            ? c.TICKER_DEFAULT_SCOREBOARD_BACKGROUND
            : color;
    return (
        <SingleTickerWrap color={wrapColor}>
            <SingleTickerRows part={part} />
        </SingleTickerWrap>
    );
};

const TickerWrap = styled.div`
    position: absolute;
    z-index: ${c.TICKER_ZINDEX};

    display: grid;
    grid-template-columns: ${c.TICKER_SMALL_SIZE} auto;
    column-gap: ${c.TICKER_LONG_COLUMN_GAP};

    width: 100%;
    height: 100%;

    color: ${c.TICKER_FONT_COLOR};
`;

export const Ticker = () => {
    const dispatch = useAppDispatch();
    const isLoaded = useAppSelector((state) => state.ticker.isLoaded);
    useEffect(() => {
        if (!isLoaded) {
            return () => undefined;
        }
        dispatch(startScrolling());
        return () => { void dispatch(stopScrolling()); };
    }, [isLoaded, dispatch]);
    return (
        <TickerWrap>
            {isLoaded && (
                <>
                    <SingleTicker
                        part={TickerPart.short}
                        color={c.TICKER_SMALL_BACKGROUND}
                    />
                    <SingleTicker part={TickerPart.long} color={c.TICKER_BACKGROUND} />
                </>
            )}
        </TickerWrap>
    );
};

export default Ticker;
