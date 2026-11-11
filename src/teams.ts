import * as github from '@actions/github'
import {Octokit} from '@octokit/rest'

export async function getExistingTeamAndMembers(
  client: github.GitHub,
  org: string,
  teamSlug: string
): Promise<{
  existingTeam: Octokit.TeamsGetByNameResponse | null
  existingMembers: string[]
}> {
  let teamResponse

  try {
    teamResponse = await client.teams.getByName({org, team_slug: teamSlug})
  } catch (error) {
    // Only a 404 means the team does not exist. Anything else (5xx, rate limiting, auth) must
    // fail the run; treating it as missing makes us try to recreate an existing team, which
    // GitHub rejects with "Name must be unique for this org".
    if (error.status === 404) {
      return {existingTeam: null, existingMembers: []}
    }
    throw error
  }

  const membersResponse = await client.teams.listMembersInOrg({org, team_slug: teamSlug})

  return {
    existingTeam: teamResponse.data,
    existingMembers: membersResponse.data.map(m => m.login)
  }
}
