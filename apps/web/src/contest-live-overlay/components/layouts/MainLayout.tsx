import React from "react";
import { useTransition, type TransitionStatus } from "react-transition-state";
import styled, { Keyframes, keyframes } from "styled-components";
import c from "../../config";
import { useAppSelector } from "../../redux/hooks";
import { useQueryParams } from "../../utils/query-params";
import { StatusLightBulbs } from "../organisms/status/StatusLightBulbs";
import Advertisement from "../organisms/widgets/Advertisement";
import Pictures from "../organisms/widgets/Pictures";
import Svg from "../organisms/widgets/Svg";
import Videos from "../organisms/widgets/Videos";
import Queue from "../organisms/widgets/queue/Queue";
import Scoreboard from "../organisms/widgets/scoreboard/Scoreboard";
import Ticker from "../organisms/widgets/Ticker";
import { Spotlight } from "../organisms/widgets/Spotlight";
import Statistics from "../organisms/widgets/Statistics";
import { TeamView } from "../organisms/widgets/TeamView";
// import PVP from "../organisms/widgets/PVP";
import FullScreenClock from "../organisms/widgets/FullScreenClock";
import { Widget } from "../../api";
import { LocationRectangle } from "../../utils/location-rectangle";

const fadeIn = keyframes`
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
`;

const fadeOut = keyframes`
  from {
    opacity: 1;
  }

  to {
    opacity: 0;
  }
`;

type WidgetWrapProps = {
    left: number | string;
    top: number | string;
    width: number | string;
    height: number | string;
    shouldCrop?: boolean;
    zIndex: number;
    animation?: Keyframes;
};

const WidgetWrap = styled.div.attrs<WidgetWrapProps>(
    ({ left, top, width, height }) => {
        return {
            style: {
                left: left + "px",
                top: top + "px",
                width: width + "px",
                height: height + "px",
            },
        };
    },
)<WidgetWrapProps>`
    position: absolute;
    z-index: ${({ zIndex }) => zIndex};

    overflow: ${({ shouldCrop = true }) => (shouldCrop ? "hidden" : "")};

    animation: ${(props) => props.animation} ${c.WIDGET_TRANSITION_TIME}ms
        linear;
    animation-fill-mode: forwards;
`;

const MainLayoutWrap = styled.div`
    width: 1920px;
    height: 1080px;
    position: relative;
`;

const transitionProps: Partial<Record<TransitionStatus, { animation?: Keyframes }>> = {
    entering: { animation: fadeIn },
    entered: {},
    exiting: { animation: fadeOut },
    exited: {},
};

type WidgetComponent = React.ComponentType<{ widgetData: Widget; transitionState: TransitionStatus }> & {
    overrideTimeout?: number;
    shouldCrop?: boolean;
    zIndex?: number;
    ignoreAnimation?: boolean;
};
const WIDGETS = {
    AdvertisementWidget: Advertisement,
    ScoreboardWidget: Scoreboard,
    QueueWidget: Queue,
    PictureWidget: Pictures,
    SvgWidget: Svg,
    VideoWidget: Videos,
    TickerWidget: Ticker,
    StatisticsWidget: Statistics,
    SpotlightWidget: Spotlight,
    TeamViewWidget: TeamView,
    FullScreenClockWidget: FullScreenClock,
};

const useWidgets = () => {
    const widgetsFromState = useAppSelector((state) => state.widgets.widgets);

    return widgetsFromState;
};

const WidgetWithTransition: React.FC<{
    obj: Widget;
    params: URLSearchParams;
}> = ({ obj, params }) => {
    const WidgetComponent = (WIDGETS as unknown as Partial<Record<Widget["type"], WidgetComponent>>)[obj.type];
    const location = c.WIDGET_POSITIONS[
        obj.widgetLocationId
    ] as LocationRectangle;

    const [transition, toggle] = useTransition({
        timeout: WidgetComponent?.overrideTimeout ?? c.WIDGET_TRANSITION_TIME,
        mountOnEnter: true,
        unmountOnExit: true,
        enter: true,
        exit: true,
    });

    const onlyWidgets = params.get("onlyWidgets")?.split(",");
    const shouldShow = React.useMemo(() => {
        if (WidgetComponent === undefined) {
            return false;
        }
        if (
            onlyWidgets &&
            !onlyWidgets.includes(obj.widgetId)
        ) {
            return false;
        }
        return true;
    }, [WidgetComponent, obj, onlyWidgets]);

    React.useEffect(() => {
        toggle(shouldShow);
    }, [shouldShow, toggle]);

    if (!shouldShow || !transition.isMounted || !location || !WidgetComponent) {
        return null;
    }

    return (
        <WidgetWrap
            data-widget={obj.widgetId}
            left={location.positionX}
            top={location.positionY}
            width={location.sizeX}
            height={location.sizeY}
            shouldCrop={WidgetComponent.shouldCrop}
            zIndex={WidgetComponent.zIndex ?? 0}
            {...(!WidgetComponent.ignoreAnimation &&
                transitionProps[transition.status])}
        >
            <WidgetComponent
                widgetData={obj}
                transitionState={transition.status}
            />
        </WidgetWrap>
    );
};

export const MainLayout = ({ noStatus = false }: { noStatus?: boolean }) => {
    const widgets = useWidgets();
    const params = useQueryParams();
    return (
        <MainLayoutWrap>
            {!noStatus && <StatusLightBulbs compact={true} />}
            {Object.values(widgets).map((obj) => (
                <WidgetWithTransition
                    key={obj.widgetId}
                    obj={obj}
                    params={params}
                />
            ))}
        </MainLayoutWrap>
    );
};

export default MainLayout;
