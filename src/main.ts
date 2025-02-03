import * as core from '@actions/core'
import * as github from '@actions/github'
import {Octokit} from '@octokit/rest'
import slugify from '@sindresorhus/slugify'
import {readFileSync} from 'fs'
import * as yaml from 'js-yaml'

interface TeamData {
  members: string[]
  team_sync_ignored?: boolean
  description?: string
  parent_team?: string
}

async function run(): Promise<void> {
  try {
    const PERSONAL_TOKEN_TYPE = 'personal'
    const APP_TOKEN_TYPE = 'app'
    const token = core.getInput('repo-token', {required: true})
    const teamDataPath = core.getInput('team-data-path')
    const teamNamePrefix = core.getInput('prefix-teams-with')
    const tokenType = core.getInput('github-token-type')
    const allowInviteUsers = JSON.parse(core.getInput('allow-invite-members'))

    core.debug(`tokenType: ${tokenType}, allowInviteUsers: ${allowInviteUsers}`)
    const client = new github.GitHub(token)
    const org = github.context.repo.owner

    let authenticatedUserResponse = null
    let authenticatedUser = null
    if (tokenType === PERSONAL_TOKEN_TYPE) {
      core.debug('Fetching authenticated user')
      authenticatedUserResponse = await client.users.getAuthenticated()
      authenticatedUser = authenticatedUserResponse.data.login
      core.info(`GitHub client is authenticated as ${authenticatedUser}`)
    } else {
      core.info('Running as app, did not get authenticated user')
    }

    core.info(`Fetching team data from ${teamDataPath}`)
    const teamDataContent = fetchContent(teamDataPath)

    core.debug(`raw teams config:\n${teamDataContent}`)

    const teams = parseTeamData(teamDataContent)

    core.debug(
      `Parsed teams configuration into this mapping of team names to team data: ${JSON.stringify(
        Object.fromEntries(teams)
      )}`
    )

    await synchronizeTeamData(
      client,
      org,
      authenticatedUser,
      teams,
      teamNamePrefix,
      allowInviteUsers
    )
  } catch (error) {
    core.error(error)
    core.setFailed(error.message)
  }
}

async function synchronizeTeamData(
  client: github.GitHub,
  org: string,
  authenticatedUser: string | null,
  teams: Map<string, TeamData>,
  teamNamePrefix: string,
  allowInviteUsers: boolean
): Promise<void> {
  const existingTeams = await client.teams.list({
    org: org
  })
  const existingTeamsMap: {[key: string]: number} = {}
  for (const existingTeam of existingTeams.data) {
    existingTeamsMap[existingTeam.name] = existingTeam.id
  }

  for (const [unprefixedTeamName, teamData] of teams.entries()) {
    const teamName = prefixName(unprefixedTeamName, teamNamePrefix)
    const teamSlug = slugify(teamName, {decamelize: false})

    if (teamData.team_sync_ignored) {
      core.debug(`Ignoring team ${unprefixedTeamName} due to its team_sync_ignored property`)
      continue
    }

    const {description, members: desiredMembers} = teamData

    core.debug(`Desired team members for team slug ${teamSlug}:`)
    core.debug(JSON.stringify(desiredMembers))

    const {existingTeam, existingMembers} = await getExistingTeamAndMembers(client, org, teamSlug)

    if (existingTeam) {
      core.debug(`Existing team members for team slug ${teamSlug}:`)
      core.debug(JSON.stringify(existingMembers))

      await client.teams.updateInOrg({org, team_slug: teamSlug, name: teamName, description})
      await removeFormerTeamMembers(client, org, teamSlug, existingMembers, desiredMembers)
    } else {
      core.info(`No team was found in ${org} with slug ${teamSlug}. Creating one.`)
      const parentTeamId =
        teamData.parent_team !== undefined ? existingTeamsMap[teamData.parent_team] : null
      await createTeamWithNoMembers(
        client,
        org,
        teamName,
        teamSlug,
        authenticatedUser,
        description,
        parentTeamId
      )
    }
    core.info(`Adding new team members to ${teamSlug}`)
    await addNewTeamMembers(
      client,
      org,
      teamSlug,
      existingMembers,
      desiredMembers,
      allowInviteUsers
    )
  }
}

function parseTeamData(rawTeamConfig: string): Map<string, TeamData> {
  const teamsData = JSON.parse(JSON.stringify(yaml.safeLoad(rawTeamConfig)))
  const unexpectedFormatError = new Error(
    'Unexpected team data format (expected an object mapping team names to team metadata)'
  )

  if (typeof teamsData !== 'object') {
    throw unexpectedFormatError
  }

  const teams: Map<string, TeamData> = new Map()
  for (const teamName in teamsData) {
    const teamData = teamsData[teamName]

    if (teamData.members) {
      const {members} = teamData

      if (Array.isArray(members)) {
        const teamGitHubUsernames: string[] = []

        for (const member of members) {
          if (typeof member.github === 'string') {
            teamGitHubUsernames.push(member.github)
          } else {
            throw new Error(`Invalid member data encountered within team ${teamName}`)
          }
        }

        const parsedTeamData: TeamData = {members: teamGitHubUsernames}

        if ('description' in teamData) {
          const {description} = teamData

          if (typeof description === 'string') {
            parsedTeamData.description = description
          } else {
            throw new Error(`Invalid description property for team ${teamName} (expected a string)`)
          }
        }

        if ('parent_team' in teamData) {
          const {parent_team} = teamData

          if (typeof parent_team === 'string') {
            parsedTeamData.parent_team = parent_team
          } else {
            throw new Error(`Invalid parent_team property for team ${teamName} (expected a string)`)
          }
        }

        if ('team_sync_ignored' in teamData) {
          const {team_sync_ignored} = teamData

          if (typeof team_sync_ignored === 'boolean') {
            parsedTeamData.team_sync_ignored = team_sync_ignored
          } else {
            throw new Error(
              `Invalid team_sync_ignored property for team ${teamName} (expected a boolean)`
            )
          }
        }

        teams.set(teamName, parsedTeamData)
        continue
      }
    }

    throw unexpectedFormatError
  }

  return teams
}

function prefixName(unprefixedName: string, prefix: string): string {
  const trimmedPrefix = prefix.trim()

  return trimmedPrefix === '' ? unprefixedName : `${trimmedPrefix} ${unprefixedName}`
}

async function removeFormerTeamMembers(
  client: github.GitHub,
  org: string,
  teamSlug: string,
  existingMembers: string[],
  desiredMembers: string[]
): Promise<void> {
  core.info(`Desired members: ${desiredMembers}`)
  for (const username of existingMembers) {
    core.info(`Checking if ${username} is in desired members`)
    if (!desiredMembers.includes(username)) {
      core.info(`Removing ${username} from ${teamSlug}`)
      await client.teams.removeMembershipInOrg({org, team_slug: teamSlug, username})
    } else {
      core.debug(`Keeping ${username} in ${teamSlug}`)
    }
  }
}

async function addNewTeamMembers(
  client: github.GitHub,
  org: string,
  teamSlug: string,
  existingMembers: string[],
  desiredMembers: string[],
  allowInviteUsers: boolean
): Promise<void> {
  for (const username of desiredMembers) {
    if (!existingMembers.includes(username)) {
      let addUser = true
      // if
      if (!allowInviteUsers) {
        const response = await client.orgs.checkMembership({
          org: org,
          username: username
        })
        if (response.status === 204) {
          console.log(`${username} is a member of ${org}.`)
          addUser = true
        } else {
          console.log(`${username} is not a member of ${org}.`)
          addUser = false
        }
      }
      if (addUser) {
        core.info(`Adding ${username} to ${teamSlug}`)
        await client.teams.addOrUpdateMembershipInOrg({org, team_slug: teamSlug, username})
      } else {
        core.info(`${username} is not a member of ${org} yet, so not adding to ${teamSlug}`)
      }
    }
  }
}

async function createTeamWithNoMembers(
  client: github.GitHub,
  org: string,
  teamName: string,
  teamSlug: string,
  authenticatedUser: string | null,
  description?: string,
  parentTeamId?: number | null
): Promise<void> {
  let createTeamRequest: Octokit.TeamsCreateParams = {
    org,
    name: teamName,
    description,
    privacy: 'closed'
  }
  if (parentTeamId != null) {
    createTeamRequest.parent_team_id = parentTeamId
  }

  await client.teams.create(createTeamRequest)

  if (authenticatedUser != null) {
    core.debug(`Removing creator (${authenticatedUser}) from ${teamSlug}`)

    await client.teams.removeMembershipInOrg({
      org,
      team_slug: teamSlug,
      username: authenticatedUser
    })
  }
}

async function getExistingTeamAndMembers(
  client: github.GitHub,
  org: string,
  teamSlug: string
): Promise<{
  existingTeam: Octokit.TeamsGetByNameResponse | null
  existingMembers: string[]
}> {
  let existingTeam
  let existingMembers: string[] = []

  try {
    const teamResponse = await client.teams.getByName({org, team_slug: teamSlug})

    existingTeam = teamResponse.data

    const membersResponse = await client.teams.listMembersInOrg({org, team_slug: teamSlug})

    existingMembers = membersResponse.data.map(m => m.login)
  } catch (error) {
    existingTeam = null
  }

  return {existingTeam, existingMembers}
}

function fetchContent(path: string): string {
  return readFileSync(path).toString()
}

run()
