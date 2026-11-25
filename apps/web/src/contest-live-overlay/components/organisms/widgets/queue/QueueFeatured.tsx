import React from "react";
import { useTransition, type TransitionStatus } from "react-transition-state";
import styled, { css, type RuleSet } from "styled-components";
import c from "../../../../config";
import { TeamMediaHolder } from "../../holder/TeamMediaHolder";
import { QueueRow } from "./QueueRow";
import { QueueRowInfo } from "./utils/queueState";
import { slideInFromRight, slideOutToRight } from "./utils/animations";

const appearStatesFeatured: Partial<Record<TransitionStatus, RuleSet>> = {
    entering: css`
        animation: ${slideInFromRight()}
            ${c.QUEUE_ROW_FEATURED_RUN_APPEAR_TIME}ms ease-out;
    `,
    exiting: css`
        animation: ${slideOutToRight()}
            ${c.QUEUE_ROW_FEATURED_RUN_APPEAR_TIME}ms ease-in;
    `,
    exited: css`
        opacity: 0;
    `,
};

const StyledFeatured = styled.div<{ additional?: RuleSet }>`
    width: ${c.QUEUE_FEATURED_RUN_WIDTH};
    position: absolute;

    right: calc(100% - ${c.QUEUE_FEATURED_RUN_RIGHT_OFFSET});
    padding: ${c.QUEUE_FEATURED_RUN_PADDING_TOP}
        ${c.QUEUE_FEATURED_RUN_PADDING_RIGHT}
        ${c.QUEUE_FEATURED_RUN_PADDING_BOTTOM}
        ${c.QUEUE_FEATURED_RUN_PADDING_LEFT};

    background-color: ${c.QUEUE_BACKGROUND_COLOR};
    border-radius: ${c.QUEUE_FEATURED_RUN_BORDER_RADIUS_TOP_LEFT} 0 0
        ${c.QUEUE_FEATURED_RUN_BORDER_RADIUS_BOTTOM_LEFT};
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: ${c.QUEUE_ROW_FEATURED_RUN_PADDING}px;

    ${({ additional }) => additional}
`;

const StyledHorizontalFeatured = styled.div<{ additional?: RuleSet }>`
    width: ${c.QUEUE_HORIZONTAL_FEATURED_RUN_WIDTH};
    position: absolute;

    right: 0;
    bottom: 100%;
    padding: ${c.QUEUE_WRAP_PADDING}px;

    background-color: ${c.QUEUE_BACKGROUND_COLOR};
    border-radius: ${c.QUEUE_HORIZONTAL_FEATURED_RUN_BORDER_RADIUS_TOP_LEFT}
        ${c.QUEUE_HORIZONTAL_FEATURED_RUN_BORDER_RADIUS_TOP_RIGHT} 0 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: ${c.QUEUE_ROW_FEATURED_RUN_PADDING}px;

    ${({ additional }) => additional}
`;

const FeaturedCaption = styled.div`
    padding: 8px;
    color: ${c.GLOBAL_TEXT_COLOR};
    font: ${c.GLOBAL_DEFAULT_FONT};
    overflow-wrap: anywhere;
`;

export const Featured = ({ runInfo }: { runInfo: QueueRowInfo | null }) => {
    const [transition, toggle] = useTransition({
        timeout: c.QUEUE_ROW_FEATURED_RUN_APPEAR_TIME,
        mountOnEnter: true,
        unmountOnExit: true,
    });

    React.useEffect(() => {
        toggle(!!runInfo);
    }, [runInfo, toggle]);

    if (!runInfo || !transition.isMounted) {
        return null;
    }

    const realState = (runInfo.isFeaturedRunMediaLoaded || !runInfo.featuredRunMedia?.length || runInfo.featuredCaption)
        ? transition.status
        : "exited";

    return (
        <StyledFeatured additional={appearStatesFeatured[realState]}>
            <TeamMediaHolder
                media={runInfo.featuredRunMedia?.[0]}
                onLoadStatus={runInfo.setIsFeaturedRunMediaLoaded}
            />
            {runInfo.featuredCaption && <FeaturedCaption>{runInfo.featuredCaption}</FeaturedCaption>}
            <QueueRow runInfo={runInfo} />
        </StyledFeatured>
    );
};

export const HorizontalFeatured = ({
    runInfo,
}: {
    runInfo: QueueRowInfo | null;
}) => {
    const [transition, toggle] = useTransition({
        timeout: c.QUEUE_ROW_FEATURED_RUN_APPEAR_TIME,
        mountOnEnter: true,
        unmountOnExit: true,
    });

    React.useEffect(() => {
        toggle(!!runInfo);
    }, [runInfo, toggle]);

    if (!runInfo || !transition.isMounted) {
        return null;
    }

    const realState = (runInfo.isFeaturedRunMediaLoaded || !runInfo.featuredRunMedia?.length || runInfo.featuredCaption)
        ? transition.status
        : "exited";

    return (
        <StyledHorizontalFeatured additional={appearStatesFeatured[realState]}>
            <TeamMediaHolder
                media={runInfo.featuredRunMedia?.[0]}
                onLoadStatus={runInfo.setIsFeaturedRunMediaLoaded}
            />
            {runInfo.featuredCaption && <FeaturedCaption>{runInfo.featuredCaption}</FeaturedCaption>}
            <QueueRow runInfo={runInfo} />
        </StyledHorizontalFeatured>
    );
};
