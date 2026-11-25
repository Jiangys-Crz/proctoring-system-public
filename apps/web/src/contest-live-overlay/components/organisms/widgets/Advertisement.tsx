import React from "react";
import styled from "styled-components";
import type { Widget } from "../../../api";
import c from "../../../config";

const AdvertisementContainer = styled.div`
    display: flex;
    align-items: center;
    justify-content: center;

    width: 100%;
    height: 100%;
`;

// TODO: move this to constants.js
const AdvertisementWrap = styled.div`
    padding: ${c.ADVERTISEMENT_VERTICAL_PADDING}
        ${c.ADVERTISEMENT_HORIZONTAL_PADDING};

    font-family: ${c.ADVERTISEMENT_FONT_FAMILY}, serif;
    font-size: ${c.ADVERTISEMENT_FONT_SIZE};
    font-weight: ${c.GLOBAL_DEFAULT_FONT_WEIGHT_BOLD};
    color: ${c.ADVERTISEMENT_COLOR};

    background-color: ${c.ADVERTISEMENT_BACKGROUND};
    border-radius: ${c.ADVERTISEMENT_BORDER_RADIUS};
    text-align: center;
    overflow-wrap: anywhere;
`;

export const Advertisement = ({ widgetData }: { widgetData: Widget.AdvertisementWidget }) => {
    return (
        <AdvertisementContainer>
            <AdvertisementWrap style={widgetData.widgetId === "title" ? { fontSize: 32, maxWidth: "100%" } : undefined}>
                {widgetData.advertisement.text}
                {widgetData.advertisement.subtitle && (
                    <div style={{ fontSize: "0.55em", marginTop: 8 }}>{widgetData.advertisement.subtitle}</div>
                )}
            </AdvertisementWrap>
        </AdvertisementContainer>
    );
};
export default Advertisement;
