import styled from "styled-components";
import type { Widget } from "../../../api";
import c from "../../../config";
import { useAppSelector } from "../../../redux/hooks";
import { RankLabel } from "../../atoms/ContestLabels";
import { ShrinkingBox } from "../../atoms/ShrinkingBox";

const Panel = styled.section`
    display: grid;
    gap: 3px;
    padding: 8px;
    border-radius: ${c.GLOBAL_BORDER_RADIUS};
    background: ${c.QUEUE_BACKGROUND_COLOR};
    color: ${c.GLOBAL_TEXT_COLOR};
    font: ${c.GLOBAL_DEFAULT_FONT};
`;

const Header = styled.header`
    font-weight: ${c.GLOBAL_DEFAULT_FONT_WEIGHT_BOLD};
`;

const List = styled.div`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 3px;
`;

const Entry = styled.div`
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    align-items: center;
    padding: 3px;
    background: ${c.QUEUE_ROW_BACKGROUND};
`;

export function Spotlight({ widgetData }: { widgetData: Widget.SpotlightWidget }) {
    const teams = useAppSelector(state => state.contestInfo.info?.teamsId);
    const ranks = useAppSelector(state => state.scoreboard.normal.rankById);
    return (
        <Panel>
            <Header>Team spotlight</Header>
            <List>
                {widgetData.teamIds.map(id => (
                    <Entry key={id}>
                        <RankLabel rank={ranks[id]} />
                        <ShrinkingBox text={teams?.[id]?.shortName ?? ""} />
                    </Entry>
                ))}
            </List>
        </Panel>
    );
}
