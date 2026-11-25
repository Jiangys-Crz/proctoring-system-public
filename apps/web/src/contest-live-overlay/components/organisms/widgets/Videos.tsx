import { useState } from "react";
import styled, { keyframes } from "styled-components";
import type { Widget } from "../../../api";
import c from "../../../config";
import { pushLog } from "../../../redux/debug";
import { useAppDispatch } from "../../../redux/hooks";

const slideIn = keyframes`
  from { opacity: 0.1; }
  to { opacity: 1; }
`;

const slideOut = keyframes`
  from { opacity: 1; }
  to { opacity: 0.1; }
`;

const VideosContainerWrap = styled.div<{ $loaded: boolean; $exiting: boolean }>`
    position: absolute;
    display: ({ $loaded }) => ($loaded ? "flex" : "none");
    align-items: center;
    justify-content: start;
    width: 100%;
    height: 100%;
    animation: ({ $loaded, $exiting }) => $loaded && ($exiting ? slideOut : slideIn)
        ${c.VIDEO_APPEAR_TIME}ms ({ $exiting }) => ($exiting ? "ease-in" : "ease-out");
    animation-fill-mode: forwards;
`;

const VideosContainer = styled.video`
    display: grid;
    justify-content: center;
    width: 100%;
    height: 100%;
    text-align: center;
`;

const Videos = ({ widgetData, transitionState }: { widgetData: Widget.VideoWidget; transitionState: string }) => {
    const { url } = widgetData.video;
    const [loadedSource, setLoadedSource] = useState<string | null>(null);
    const dispatch = useAppDispatch();

    return (
        <VideosContainerWrap $loaded={loadedSource === url} $exiting={transitionState === "exiting"}>
            <VideosContainer
                src={url}
                autoPlay
                muted
                playsInline
                onCanPlay={() => setLoadedSource(url)}
                onError={() => {
                    setLoadedSource(null);
                    dispatch(pushLog("ERROR on loading video in Video widget"));
                }}
            />
        </VideosContainerWrap>
    );
};

Videos.ignoreAnimation = true;
Videos.overrideTimeout = c.VIDEO_APPEAR_TIME;

export default Videos;
