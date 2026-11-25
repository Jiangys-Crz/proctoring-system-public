import c from "../../../config";
import type { Widget } from "../../../api";

const Svg = ({ widgetData }: { widgetData: Widget.SvgWidget }) => (
    // In image mode SVG keeps its intrinsic geometry and cannot run document scripts.
    <img src={widgetData.content} alt="" referrerPolicy="no-referrer" />
);

Svg.overrideTimeout = c.SVG_APPEAR_TIME;

export default Svg;
