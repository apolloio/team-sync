import * as github from '@actions/github'

export async function fetchTeamIdsByName(
  client: github.GitHub,
  org: string
): Promise<{[key: string]: number}> {
  const existingTeams = await client.paginate('GET /orgs/:org/teams', {
    org,
    per_page: 100
  })
  const teamIdsByName: {[key: string]: number} = {}

  for (const existingTeam of existingTeams) {
    teamIdsByName[existingTeam.name] = existingTeam.id
  }

  return teamIdsByName
}

export function resolveParentTeamId(
  teamSlug: string,
  parentTeamName: string | undefined,
  teamIdsByName: {[key: string]: number},
  org: string
): number | undefined {
  if (parentTeamName === undefined) {
    return undefined
  }

  const parentTeamId = teamIdsByName[parentTeamName]
  if (parentTeamId === undefined) {
    throw new Error(`Parent team ${parentTeamName} for ${teamSlug} does not exist in ${org}`)
  }

  return parentTeamId
}
