import styled from "styled-components";
import { MediaType } from "../../api";
import { useAppSelector } from "../../redux/hooks";

const Logo = styled.img`
    display: block;
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    margin-inline: 3px;
    object-fit: contain;
`;

export function OrganizationLogo({ teamId }: { teamId: string }) {
    const organization = useAppSelector(state => {
        const info = state.contestInfo.info;
        const id = info?.teamsId[teamId]?.organizationId;
        return id ? info?.organizationsById[id] : undefined;
    });
    const logo = organization?.logo.find(item => item.type === MediaType.Type.Image);
    return logo ? <Logo key={logo.url} src={logo.url} alt={organization?.displayName ?? ""} onError={event => { event.currentTarget.style.display = "none"; }} /> : null;
}
