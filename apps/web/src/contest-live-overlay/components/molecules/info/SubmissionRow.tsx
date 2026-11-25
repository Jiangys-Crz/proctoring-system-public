import React from "react";
import styled, { css } from "styled-components";
import { DateTime } from "luxon";
import c from "../../../config";
import { ProblemLabel } from "../../atoms/ProblemLabel";
import { ScoreboardTaskResultLabel } from "../../organisms/widgets/scoreboard/Scoreboard";
import { ProblemResult, TeamInfo } from "../../../api";
import { isShouldUseDarkColor } from "../../../utils/colors";
import { createShimmerStyles } from "../../../utils/shimmerStyles";

const TimeCell = styled.div`
    flex-basis: ${c.TIME_CELL_FLEX_BASIS};
    width: ${c.TIME_CELL_WIDTH};
    text-align: center;
`;

const QueueProblemLabel = styled(ProblemLabel)<{ isFts?: boolean }>`
    flex-shrink: 0;
    width: ${c.QUEUE_ROW_PROBLEM_LABEL_WIDTH}px;
    height: ${c.QUEUE_ROW_HEIGHT}px;
    font-size: ${c.QUEUE_PROBLEM_LABEL_FONT_SIZE};
    font-family: ${c.GLOBAL_DEFAULT_FONT_FAMILY};
    line-height: ${c.QUEUE_ROW_HEIGHT}px;
    display: flex;
    align-items: center;
    justify-content: center;

    ${({ isFts, problemColor }) =>
        isFts
            ? css`
                  ${createShimmerStyles(problemColor ?? undefined)}
              `
            : css`
                  background-color: ${problemColor || "#4a90e2"};
                  color: ${isShouldUseDarkColor(problemColor)
                      ? "#000"
                      : "#FFF"};
              `}
`;

const SubmissionRowWrap = styled.div<{ bg_color: string; color: string }>`
    overflow: hidden;
    display: flex;
    align-items: center;

    width: 100%;
    height: ${c.CONTESTER_ROW_HEIGHT};

    font-size: ${c.CONTESTER_FONT_SIZE};
    color: ${(props) => props.color};

    background-color: ${(props) => props.bg_color};
`;

const SubmissionColumnWrap = styled.div<{
    bg_color?: string | null;
    darkText: boolean;
}>`
    overflow: hidden;
    display: grid;
    grid-auto-flow: row;
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr 1fr;
    align-items: center;

    width: 100%;

    font-size: ${c.CONTESTER_FONT_SIZE};
    color: ${({ darkText }) => (darkText ? "#000" : "#FFF")};

    background-color: ${(props) =>
        props.bg_color ? props.bg_color : c.CONTESTER_BACKGROUND_COLOR};
`;
// border-top-left-radius: ${props => props.roundB ? "16px" : "0px"};
//   border-top-right-radius: ${props => props.roundB ? "16px" : "0px"};

const SubmissionRowTaskResultLabel = styled(ScoreboardTaskResultLabel)<{ isTop?: boolean }>`
    flex-shrink: 0;
    width: ${c.SUBMISSION_ROW_TASK_RESULT_LABEL_WIDTH};
    height: 100%;
    text-align: center;
`;

// TODO: MOVE WIDTHS TO CONFIG
// TODO: REWRITE WITHOUT isFake
type SubmissionProps = Omit<VerticalSubmissionRowProps, "teamData" | "isTop"> & {
    bg_color: string;
    color: string;
};

export const SubmissionRow = ({
    result,
    lastSubmitTimeMs,
    minScore,
    maxScore,
    problemLetter,
    problemColor,
    bg_color,
    color,
}: SubmissionProps) => {
    const isFts =
        (result?.type === "ICPC" && result.isFirstToSolve) ||
        (result?.type === "IOI" && result.isFirstBest);
    return (
        <SubmissionRowWrap bg_color={bg_color} color={color}>
            <TimeCell>
                {DateTime.fromMillis(lastSubmitTimeMs ?? 0).toFormat("H:mm")}
            </TimeCell>
            <QueueProblemLabel
                letter={problemLetter}
                problemColor={problemColor}
                isFts={isFts}
            />
            <SubmissionRowTaskResultLabel
                problemResult={result}
                minScore={minScore}
                maxScore={maxScore}
                isFake={true}
            />
        </SubmissionRowWrap>
    );
};

const PVPProblemLabel = styled(QueueProblemLabel)<{ isTop?: boolean }>`
    order: ${(props) => (props.isTop ? 3 : 1)};
    width: 100%;
`;

const PVPResultLabel = styled(ScoreboardTaskResultLabel)<{ isTop?: boolean }>`
    order: ${(props) => (props.isTop ? 1 : 3)};
`;

const PVPTimeCell = styled(TimeCell)`
    order: 2;
    width: 100%;
`;

export type VerticalSubmissionRowProps = {
    teamData?: TeamInfo;
    result: ProblemResult;
    lastSubmitTimeMs?: number | null;
    minScore?: number | null;
    maxScore?: number | null;
    problemLetter?: string;
    problemColor?: string | null;
    isTop?: boolean;
};

export const VerticalSubmissionRow = ({
    teamData,
    result,
    lastSubmitTimeMs,
    minScore,
    maxScore,
    problemLetter,
    problemColor,
    isTop,
}: VerticalSubmissionRowProps) => {
    const dark = isShouldUseDarkColor(
        teamData?.color ? teamData?.color : c.CONTESTER_BACKGROUND_COLOR,
    );
    if (!result || !problemLetter || lastSubmitTimeMs == null) {
        return (
            <SubmissionColumnWrap bg_color={teamData?.color} darkText={dark}>
                <div style={{ order: isTop ? 1 : 3 }} />
                <div style={{ order: 2 }} />
                <PVPProblemLabel
                    letter={problemLetter}
                    problemColor={problemColor}
                    isTop={isTop}
                />
            </SubmissionColumnWrap>
        );
    }
    return (
        <SubmissionColumnWrap bg_color={teamData?.color} darkText={dark}>
            <PVPResultLabel
                problemResult={result}
                minScore={minScore}
                maxScore={maxScore}
                isTop={isTop}
                problemColor={problemColor}
            />
            <PVPTimeCell>
                {DateTime.fromMillis(lastSubmitTimeMs ?? 0).toFormat("H:mm")}
            </PVPTimeCell>
            <PVPProblemLabel
                letter={problemLetter}
                problemColor={problemColor}
                isTop={isTop}
            />
        </SubmissionColumnWrap>
    );
};

export default SubmissionRow;
