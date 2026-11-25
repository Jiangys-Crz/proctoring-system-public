import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useState,
} from "react";
import styled, { Keyframes, keyframes } from "styled-components";
import c from "../../../config";
import { OverlayTeamViewSettings, TeamViewPosition, Widget } from "../../../api";
import {
    OverlayWidgetC,
    OverlayWidgetProps,
} from "./types";
import { TeamMediaHolder } from "../holder/TeamMediaHolder";
import TimeLine, {
    TimeLineBackground,
} from "../holder/TimeLine";
import { ContestantViewCorner } from "../../molecules/info/ContestantViewCorner";
import { ContestantViewLine } from "../../molecules/info/ContestantViewLine";
import { LocationRectangle } from "../../../utils/location-rectangle";

const slideIn = keyframes`
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
`;

const slideOut = keyframes`
    from {
        opacity: 1;
    }
    to {
        opacity: 0;
    }
`;

const RoundedTeamMediaHolder = styled(TeamMediaHolder)`
    border-radius: ${c.GLOBAL_BORDER_RADIUS};
    border-top-right-radius: 0;
`;

const TeamViewContainer = styled.div.attrs({
    className: "TeamViewContainer",
})<{ show: boolean; animation?: Keyframes | false; animationStyle: string }>`
    width: 100%;
    height: 100%;
    display: ${(props) => (props.show ? "flex" : "none")};
    flex-direction: column;
    justify-content: start;
    align-items: flex-end;
    position: absolute;
    animation: ${(props) => props.animation} ${c.TEAM_VIEW_APPEAR_TIME}ms
        ${(props) => props.animationStyle};
    animation-fill-mode: forwards;
`;

type CommonContentProps = {
    location: LocationRectangle;
    position?: TeamViewPosition;
    setPrimaryLoaded: (loaded: boolean) => void;
    setAchievementLoaded: (loaded: boolean) => void;
} & OverlayTeamViewSettings;

const PrimaryMediaWrapper = styled.div`
    position: absolute;
    width: 100%;
    height: 100%;
    z-index: 1;
    overflow: hidden;
`;

interface AchievementWrapperProps {
    showTimeline: boolean;
}

const AchievementWrapper = styled.div<AchievementWrapperProps>`
    position: absolute;
    width: 100%;
    height: 100%;
    overflow: hidden;
    z-index: 2;
`;

const TeamViewGrid = styled.div<{ $secondaryY: number; $achievementY: number }>`
    width: 100%;
    height: 100%;
    display: grid;
    grid-template-columns: 1fr ${(props) =>
            ((props.$secondaryY * 2) / 9) * 16}px;
    grid-template-rows: 1fr ${(props) => props.$secondaryY}px ${(props) =>
            props.$secondaryY}px ${(props) => props.$achievementY}px;
    z-index: 3;
    border-radius: ${c.GLOBAL_BORDER_RADIUS};
`;

const SecondaryMediaWrapper = styled.div<{ withAchievement: boolean }>`
    grid-column: 2 / 3;
    grid-row-start: ${(props) => (props.withAchievement ? 3 : 2)};
    grid-row-end: ${(props) => (props.withAchievement ? 5 : 4)};
    overflow: hidden;
    z-index: 3;
`;

const TaskStatusWrapper = styled.div<{
    withAchievement: boolean;
    withSecondary: boolean;
}>`
    grid-column: 2 / 3;
    grid-row-start: 1;
    grid-row-end: ${(props) =>
        props.withSecondary ? (props.withAchievement ? 3 : 2) : 4};
    display: grid;
    align-items: end;
    overflow: hidden;
    border-radius: ${c.GLOBAL_BORDER_RADIUS};
`;

const TimelineWrapper = styled.div`
    grid-column: 1 / 2;
    grid-row: 4 / 4;
    display: grid;
    align-items: end;
`;

const AchievementGridWrapper = styled.div`
    grid-column: 1 / 3;
    grid-row: 1 / 5;
    position: relative;
    z-index: 2;
`;

const teamViewVariant = (position: TeamViewPosition | undefined) => {
    if (position === TeamViewPosition.SINGLE || position === undefined) {
        return "single";
    } else if (
        position === TeamViewPosition.PVP_TOP ||
        position === TeamViewPosition.PVP_BOTTOM
    ) {
        return "pvp";
    }
    return "split";
};

const SingleContent = ({
    teamId,
    primary,
    setPrimaryLoaded,
    secondary,
    achievement,
    setAchievementLoaded,
    showTaskStatus,
    showTimeLine,
    location,
}: CommonContentProps) => {
    const achievementY = location.sizeY - (location.sizeX / 16) * 9;
    const secondaryY =
        achievementY > 0
            ? achievementY
            : (location.sizeY * c.TEAMVIEW_FULLSCREEN_SECONDARY_FACTOR) / 2;
    const hasPrimary = (primary?.length ?? 0) > 0;
    const hasSecondary = (secondary?.length ?? 0) > 0;
    const hasAchievement = (achievement?.length ?? 0) > 0;
    return (
        <>
            {hasPrimary && (
                <PrimaryMediaWrapper>
                    <RoundedTeamMediaHolder
                        media={primary[0]}
                        onLoadStatus={setPrimaryLoaded}
                    />
                </PrimaryMediaWrapper>
            )}
            <TeamViewGrid
                $secondaryY={secondaryY}
                $achievementY={achievementY > 0 ? achievementY : 0}
            >
                {hasAchievement && (
                    <AchievementGridWrapper>
                        <AchievementWrapper showTimeline={showTimeLine}>
                            <TeamMediaHolder
                                media={achievement[0]}
                                onLoadStatus={setAchievementLoaded}
                            />
                        </AchievementWrapper>
                    </AchievementGridWrapper>
                )}
                {hasSecondary && (
                    <SecondaryMediaWrapper
                        withAchievement={hasAchievement || showTimeLine}
                    >
                        <RoundedTeamMediaHolder media={secondary[0]} />
                    </SecondaryMediaWrapper>
                )}
                {showTaskStatus && (
                    <TaskStatusWrapper
                        withAchievement={hasAchievement || showTimeLine}
                        withSecondary={hasSecondary}
                    >
                        <ContestantViewCorner teamId={teamId} isSmall={false} />
                    </TaskStatusWrapper>
                )}
                {showTimeLine && (
                    <TimelineWrapper>
                        <div>
                            <TimeLine teamId={teamId} />
                        </div>
                    </TimelineWrapper>
                )}
                {showTimeLine && <TimeLineBackground teamId={teamId} />}
            </TeamViewGrid>
        </>
    );
};

type PVPWrapperProps = { $isTop: boolean };

const PVPGrid = styled.div<
    { $primaryY: number; $secondaryY: number } & PVPWrapperProps
>`
    width: 100%;
    height: 100%;
    display: grid;
    grid-template-columns: ${(props) =>
            (props.$primaryY / c.PVP_ASPECT_RATIO_HEIGHT) *
            c.PVP_ASPECT_RATIO_WIDTH}px ${(props) =>
            (props.$secondaryY / c.PVP_ASPECT_RATIO_HEIGHT) *
            c.PVP_ASPECT_RATIO_WIDTH}px;
    grid-template-rows: ${(props) =>
        props.$isTop
            ? `${props.$secondaryY}px 1fr ${c.PVP_TABLE_ROW_HEIGHT * c.PVP_TABLE_ROW_HEIGHT_MULTIPLIER}px ${c.PVP_TABLE_ROW_HEIGHT * c.PVP_TABLE_ROW_HEIGHT_OFFSET_MULTIPLIER}px`
            : `${c.PVP_TABLE_ROW_HEIGHT * c.PVP_TABLE_ROW_HEIGHT_OFFSET_MULTIPLIER}px ${c.PVP_TABLE_ROW_HEIGHT * c.PVP_TABLE_ROW_HEIGHT_MULTIPLIER}px 1fr ${props.$secondaryY}px`};
    z-index: 1;
    border-radius: ${c.GLOBAL_BORDER_RADIUS};
    overflow: hidden;
`;

const PVPPrimaryMediaWrapper = styled.div<PVPWrapperProps>`
    grid-column: 1 / 2;
    grid-row: ${(props) => (props.$isTop ? "1 / 4" : "2 / 5")};
`;

const PVPSecondaryMediaWrapper = styled.div<PVPWrapperProps>`
    grid-column: 2;
    grid-row: ${(props) => (props.$isTop ? "1 / 2" : "4 / 5")};
`;

const PVPTaskStatusWrapper = styled.div<PVPWrapperProps>`
    position: absolute;
    width: 100%;
    height: ${c.PVP_TABLE_ROW_HEIGHT * 3 + "px"};
    top: ${(props) => (props.$isTop ? "auto" : 0)};
    bottom: ${(props) => (!props.$isTop ? "auto" : 0)};
    z-index: 2;
    overflow: hidden;
    display: grid;
    justify-items: end;
`;

const PVPAchievementWrapper = styled.div<PVPWrapperProps>`
    grid-column: 2;
    grid-row: ${(props) => (props.$isTop ? "2 / 3" : "3 / 4")};
    display: grid;
    position: relative;
    background: ${c.PVP_BACKGROUND};
    overflow: hidden;
`;

const PVPTackStatusBackWrapper = styled.div<PVPWrapperProps>`
    grid-column: 2;
    grid-row: ${(props) => (props.$isTop ? "3 / 4" : "2 / 3")};
    background: ${c.PVP_BACKGROUND};
`;

const PVPAchievementInnerWrapper = styled.div`
    position: absolute;
    width: ${c.PVP_ACHIEVEMENT_WIDTH};
    bottom: ${c.PVP_ACHIEVEMENT_BOTTOM_OFFSET};
    z-index: 4;

    object {
        width: 100%;
        height: 100%;
    }
`;

const PVPContent = ({
    teamId,
    primary,
    setPrimaryLoaded,
    secondary,
    achievement,
    setAchievementLoaded,
    showTaskStatus,
    showTimeLine,
    location,
    position,
}: CommonContentProps) => {
    const isTop = position === TeamViewPosition.PVP_TOP;
    const primaryY = location.sizeY - 0.5 * c.PVP_TABLE_ROW_HEIGHT;
    const secondaryY =
        ((location.sizeX -
            ((location.sizeY - 0.5 * c.PVP_TABLE_ROW_HEIGHT) / 9) * 16) /
            16) *
        9;
    const hasPrimary = (primary?.length ?? 0) > 0;
    const hasSecondary = (secondary?.length ?? 0) > 0;
    const hasAchievement = (achievement?.length ?? 0) > 0;
    return (
        <>
            <PVPGrid
                $primaryY={primaryY}
                $secondaryY={secondaryY}
                $isTop={isTop}
            >
                {hasPrimary && (
                    <PVPPrimaryMediaWrapper $isTop={isTop}>
                        <TeamMediaHolder
                            media={primary[0]}
                            onLoadStatus={setPrimaryLoaded}
                        />
                    </PVPPrimaryMediaWrapper>
                )}
                {hasSecondary && (
                    <PVPSecondaryMediaWrapper $isTop={isTop}>
                        <TeamMediaHolder media={secondary[0]} />
                    </PVPSecondaryMediaWrapper>
                )}
                {hasAchievement && (
                    <PVPAchievementWrapper $isTop={isTop}>
                        <PVPAchievementInnerWrapper>
                            <TeamMediaHolder
                                media={achievement[0]}
                                onLoadStatus={setAchievementLoaded}
                            />
                        </PVPAchievementInnerWrapper>
                    </PVPAchievementWrapper>
                )}
                {showTimeLine && (
                    <PVPAchievementWrapper $isTop={isTop}>
                        <TimeLine teamId={teamId} isPvp={true} />
                    </PVPAchievementWrapper>
                )}
                <PVPTackStatusBackWrapper $isTop={isTop} />
            </PVPGrid>
            {showTaskStatus && (
                <PVPTaskStatusWrapper $isTop={isTop}>
                    <ContestantViewLine
                        teamId={teamId}
                        isTop={isTop}
                        tasksContainerY={(secondaryY / 9) * 16}
                    />
                </PVPTaskStatusWrapper>
            )}
        </>
    );
};

const SplitScreenGrid = styled.div<{ $secondaryY: number }>`
    width: 100%;
    height: 100%;
    display: grid;
    grid-template-columns: 1fr ${(props) =>
            (props.$secondaryY / c.PVP_ASPECT_RATIO_HEIGHT) *
            c.PVP_ASPECT_RATIO_WIDTH}px;
    grid-template-rows: 1fr ${(props) =>
            props.$secondaryY / c.PVP_SECONDARY_DIVISOR}px ${(props) =>
            props.$secondaryY / c.PVP_SECONDARY_DIVISOR}px;
    z-index: 3;
    border-radius: ${c.GLOBAL_BORDER_RADIUS};
`;

const SplitContent = ({
    teamId,
    primary,
    setPrimaryLoaded,
    secondary,
    showTaskStatus,
    location,
}: CommonContentProps) => {
    const hasPrimary = (primary?.length ?? 0) > 0;
    const hasSecondary = (secondary?.length ?? 0) > 0;
    return (
        <>
            {hasPrimary && (
                <PrimaryMediaWrapper>
                    <RoundedTeamMediaHolder
                        media={primary[0]}
                        onLoadStatus={setPrimaryLoaded}
                    />
                </PrimaryMediaWrapper>
            )}
            <SplitScreenGrid
                $secondaryY={location.sizeY * c.SPLITSCREEN_SECONDARY_FACTOR}
            >
                {hasSecondary && (
                    <SecondaryMediaWrapper withAchievement={false}>
                        <RoundedTeamMediaHolder media={secondary[0]} />
                    </SecondaryMediaWrapper>
                )}
                {showTaskStatus && (
                    <TaskStatusWrapper
                        withAchievement={false}
                        withSecondary={hasSecondary}
                    >
                        <ContestantViewCorner teamId={teamId} isSmall={false} />
                    </TaskStatusWrapper>
                )}
            </SplitScreenGrid>
        </>
    );
};

export const TeamView: OverlayWidgetC<Widget.TeamViewWidget> = ({
    widgetData,
    transitionState,
}) => {
    const { settings } = widgetData;
    const [current, setCurrent] = useState(settings);
    const [loaded, setLoaded] = useState<OverlayTeamViewSettings>();
    const next = current.teamId !== settings.teamId ? settings : null;
    const onNextLoaded = useCallback(() => setLoaded(settings), [settings]);

    useLayoutEffect(() => {
        if (!next) {
            setCurrent(settings);
            setLoaded(undefined);
        }
    }, [next, settings]);

    useEffect(() => {
        if (!next || loaded !== next) return;
        const timer = setTimeout(() => setCurrent(next), c.TEAM_VIEW_APPEAR_TIME);
        return () => clearTimeout(timer);
    }, [loaded, next]);

    return (
        <>
            <TeamViewSingleContent
                key={current.teamId}
                widgetData={{ ...widgetData, settings: next ? current : settings }}
                transitionState={transitionState}
            />
            {next && (
                <TeamViewSingleContent
                    key={next.teamId}
                    widgetData={widgetData}
                    transitionState={transitionState}
                    onLoaded={onNextLoaded}
                />
            )}
        </>
    );
};

type TeamViewSingleContentProps = OverlayWidgetProps<Widget.TeamViewWidget> & {
    onLoaded?: () => void;
};

export const TeamViewSingleContent: React.FC<TeamViewSingleContentProps> = ({
    widgetData: { settings, widgetLocationId },
    transitionState,
    onLoaded,
}) => {
    const { primary, achievement, position } = settings;
    const location = c.WIDGET_POSITIONS[widgetLocationId] as LocationRectangle;
    const variant = teamViewVariant(position);

    const primaryMedia = primary?.[0];
    const achievementMedia = variant === "pvp" ? achievement?.[0] : undefined;
    const primaryKey = primaryMedia && `${primaryMedia.type}:${primaryMedia.url}`;
    const achievementKey = achievementMedia && `${achievementMedia.type}:${achievementMedia.url}`;
    const sceneKey = JSON.stringify([primaryKey, achievementKey]);
    const [loadedPrimary, setLoadedPrimary] = useState<string>();
    const [loadedAchievement, setLoadedAchievement] = useState<string>();
    const [shownScene, setShownScene] = useState<string>();
    const setPrimaryLoaded = useCallback((loaded: boolean) => setLoadedPrimary(loaded ? primaryKey : undefined), [primaryKey]);
    const setAchievementLoaded = useCallback((loaded: boolean) => setLoadedAchievement(loaded ? achievementKey : undefined), [achievementKey]);
    const mediaReady = (!primaryKey || primaryKey === loadedPrimary) && (!achievementKey || achievementKey === loadedAchievement);
    const show = mediaReady || sceneKey === shownScene;

    useEffect(() => {
        if (mediaReady) {
            setShownScene(sceneKey);
            return;
        }
        if (show) return;
        // Leave room for negotiation, then show the team data even if the stream fails.
        const timer = setTimeout(() => setShownScene(sceneKey), 3 * c.TEAM_VIEW_APPEAR_TIME);
        return () => clearTimeout(timer);
    }, [mediaReady, sceneKey, show]);

    useLayoutEffect(() => {
        if (show) onLoaded?.();
    }, [show, onLoaded]);

    const props = {
        ...settings,
        setPrimaryLoaded,
        setAchievementLoaded,
        location,
    };
    return (
        <TeamViewContainer
            show={show}
            animation={
                show && (transitionState === "exiting" ? slideOut : slideIn)
            }
            animationStyle={
                transitionState === "exiting" ? "ease-in" : "ease-out"
            }
            data-teamid={settings?.teamId}
        >
            {variant === "single" && <SingleContent {...props} />}
            {variant === "pvp" && <PVPContent {...props} />}
            {variant === "split" && <SplitContent {...props} />}
        </TeamViewContainer>
    );
};
TeamView.ignoreAnimation = true;
TeamView.overrideTimeout = c.TEAM_VIEW_APPEAR_TIME;
