import { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import { createProctorWebRtcReader } from "../../../../../public/live-webrtc.js";
import { MediaType } from "../../../api";

type MediaHolderProps = {
    media: MediaType | undefined;
    onLoadStatus?: ((loaded: boolean) => void) | null;
    className?: string;
};

const MediaWrapper = styled.div<{ $vertical?: boolean }>`
    overflow: hidden;
    text-align: right;
    width: 100%;
    height: ${({ $vertical }) => ($vertical ? "100%" : "auto")};
    max-width: 100%;
    max-height: 100%;

    > img, > video {
        width: ${({ $vertical }) => ($vertical ? "auto" : "100%")};
        height: ${({ $vertical }) => ($vertical ? "100%" : "auto")};
        overflow: hidden;
    }
`;

const LiveVideo = ({ media, onLoadStatus, className }: Omit<MediaHolderProps, "media"> & {
    media: MediaType.ProctorWebRTC;
}) => {
    const element = useRef<HTMLVideoElement>(null);
    const notify = useRef(onLoadStatus);
    const [playing, setPlaying] = useState(false);
    useEffect(() => { notify.current = onLoadStatus; }, [onLoadStatus]);
    useEffect(() => {
        const video = element.current;
        if (!video || typeof RTCPeerConnection === "undefined") return;
        let active = true;
        const reader = createProctorWebRtcReader({
            url: media.url,
            onTrack: (event) => {
                if (event.track.kind !== "video") return;
                video.srcObject = event.streams[0] || new MediaStream([event.track]);
                void video.play().catch(() => {});
            },
            onReset: () => {
                video.srcObject = null;
                if (!active) return;
                setPlaying(false);
                notify.current?.(false);
            },
        });
        const onPlaying = () => {
            setPlaying(true);
            notify.current?.(true);
        };
        video.addEventListener("playing", onPlaying);
        return () => {
            active = false;
            video.removeEventListener("playing", onPlaying);
            reader.close();
        };
    }, [media.url]);
    return (
        <MediaWrapper className={className} style={{ visibility: playing ? undefined : "hidden" }}>
            <video ref={element} autoPlay muted playsInline />
        </MediaWrapper>
    );
};

export const TeamMediaHolder = ({ media, onLoadStatus, className }: MediaHolderProps) => {
    if (!media) return null;
    switch (media.type) {
        case MediaType.Type.Image:
            return (
                <MediaWrapper className={className} $vertical={media.vertical}>
                    <img src={media.url} alt="Team photo" onLoad={() => onLoadStatus?.(true)} onError={() => onLoadStatus?.(false)} />
                </MediaWrapper>
            );
        case MediaType.Type.ProctorWebRTC:
            return <LiveVideo key={media.url} media={media} onLoadStatus={onLoadStatus} className={className} />;
        default:
            return null;
    }
};
