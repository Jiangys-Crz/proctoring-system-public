import React from "react";
import styled from "styled-components";
import { TickerMessageSettings } from "../../../api";
import c from "../../../config";

export const ImageWrap = styled.img`
    width: 100%;
    height: 100%;
    max-height: 100%;
    max-width: 100%;
    display: flex;
    padding: 0 ${c.IMAGE_TICKER_HORIZONTAL_PADDING};
    box-sizing: border-box;
    object-fit: contain;
`;

type ImageProps = { tickerSettings: TickerMessageSettings.image };

export const Image = ({ tickerSettings }: ImageProps) => {
    return <ImageWrap src={tickerSettings.path} alt="" />;
};

export default Image;
