/**
 * DEPRECATED — Do not use sampleMatches.
 * Live data comes from GET /api/matches (LiveScore 6 via RapidAPI).
 * This stub prevents TypeScript errors from legacy imports.
 */
import { Match } from '@/lib/types/match';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sampleMatches: Match[] = [] as any[];

const _unused = [
  {
    id: '1',
    fixture_id: 1001,
    league: 'Premier League',
    country: 'England',
    home_team: 'Manchester United',
    away_team: 'Liverpool',
    home_team_logo: 'https://media.api-sports.io/teams/33.png',
    away_team_logo: 'https://media.api-sports.io/teams/40.png',
    kickoff_time: '2024-01-15T15:00:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 2.10, x: 3.40, two: 3.20 },
      over_under_2_5: { over: 1.95, under: 1.85 },
      both_teams_to_score: { yes: 1.72, no: 2.10 }
    }
  },
  {
    id: '2',
    fixture_id: 1002,
    league: 'Premier League',
    country: 'England',
    home_team: 'Arsenal',
    away_team: 'Chelsea',
    home_team_logo: 'https://media.api-sports.io/teams/42.png',
    away_team_logo: 'https://media.api-sports.io/teams/49.png',
    kickoff_time: '2024-01-15T17:30:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 2.05, x: 3.50, two: 3.40 },
      over_under_2_5: { over: 1.90, under: 1.90 },
      both_teams_to_score: { yes: 1.80, no: 2.00 }
    }
  },
  {
    id: '3',
    fixture_id: 1003,
    league: 'Premier League',
    country: 'England',
    home_team: 'Manchester City',
    away_team: 'Tottenham',
    home_team_logo: 'https://media.api-sports.io/teams/50.png',
    away_team_logo: 'https://media.api-sports.io/teams/47.png',
    kickoff_time: '2024-01-15T20:00:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 1.50, x: 4.00, two: 6.50 },
      over_under_2_5: { over: 2.10, under: 1.75 },
      both_teams_to_score: { yes: 2.20, no: 1.65 }
    }
  },
  {
    id: '4',
    fixture_id: 1004,
    league: 'La Liga',
    country: 'Spain',
    home_team: 'Real Madrid',
    away_team: 'Barcelona',
    home_team_logo: 'https://media.api-sports.io/teams/541.png',
    away_team_logo: 'https://media.api-sports.io/teams/529.png',
    kickoff_time: '2024-01-15T16:15:00Z',
    status: 'live',
    home_score: 1,
    away_score: 0,
    minute: 34,
    halftime_home: 1,
    halftime_away: 0,
    events: [
      { minute: 12, type: 'goal', team: 'home', player: 'Vinicius Jr' }
    ],
    odds: {
      one_x_two: { one: 1.95, x: 3.60, two: 3.80 },
      over_under_2_5: { over: 1.88, under: 1.92 },
      both_teams_to_score: { yes: 1.75, no: 2.05 }
    }
  },
  {
    id: '5',
    fixture_id: 1005,
    league: 'Serie A',
    country: 'Italy',
    home_team: 'Juventus',
    away_team: 'AC Milan',
    home_team_logo: 'https://media.api-sports.io/teams/496.png',
    away_team_logo: 'https://media.api-sports.io/teams/489.png',
    kickoff_time: '2024-01-15T18:00:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 2.20, x: 3.30, two: 3.10 },
      over_under_2_5: { over: 1.92, under: 1.88 },
      both_teams_to_score: { yes: 1.78, no: 2.02 }
    }
  },
  {
    id: '6',
    fixture_id: 1006,
    league: 'Bundesliga',
    country: 'Germany',
    home_team: 'Bayern Munich',
    away_team: 'Borussia Dortmund',
    home_team_logo: 'https://media.api-sports.io/teams/157.png',
    away_team_logo: 'https://media.api-sports.io/teams/165.png',
    kickoff_time: '2024-01-15T19:30:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 1.60, x: 3.80, two: 5.50 },
      over_under_2_5: { over: 2.05, under: 1.80 },
      both_teams_to_score: { yes: 2.00, no: 1.80 }
    }
  },
  {
    id: '7',
    fixture_id: 1007,
    league: 'Ligue 1',
    country: 'France',
    home_team: 'Paris Saint-Germain',
    away_team: 'Marseille',
    home_team_logo: 'https://media.api-sports.io/teams/549.png',
    away_team_logo: 'https://media.api-sports.io/teams/558.png',
    kickoff_time: '2024-01-15T21:00:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 1.40, x: 4.50, two: 7.50 },
      over_under_2_5: { over: 2.15, under: 1.70 },
      both_teams_to_score: { yes: 2.30, no: 1.60 }
    }
  },
  {
    id: '8',
    fixture_id: 1008,
    league: 'Premier League',
    country: 'England',
    home_team: 'Newcastle United',
    away_team: 'Brighton',
    home_team_logo: 'https://media.api-sports.io/teams/34.png',
    away_team_logo: 'https://media.api-sports.io/teams/51.png',
    kickoff_time: '2024-01-15T15:30:00Z',
    status: 'finished',
    home_score: 2,
    away_score: 1,
    halftime_home: 1,
    halftime_away: 1,
    odds: {
      one_x_two: { one: 1.90, x: 3.50, two: 3.90 },
      over_under_2_5: { over: 1.95, under: 1.85 },
      both_teams_to_score: { yes: 1.68, no: 2.15 }
    }
  },
  {
    id: '9',
    fixture_id: 1009,
    league: 'La Liga',
    country: 'Spain',
    home_team: 'Atletico Madrid',
    away_team: 'Sevilla',
    home_team_logo: 'https://media.api-sports.io/teams/530.png',
    away_team_logo: 'https://media.api-sports.io/teams/536.png',
    kickoff_time: '2024-01-15T14:00:00Z',
    status: 'finished',
    home_score: 3,
    away_score: 1,
    halftime_home: 1,
    halftime_away: 0,
    odds: {
      one_x_two: { one: 1.85, x: 3.60, two: 4.00 },
      over_under_2_5: { over: 2.10, under: 1.75 },
      both_teams_to_score: { yes: 1.82, no: 2.00 }
    }
  },
  {
    id: '10',
    fixture_id: 1010,
    league: 'Serie A',
    country: 'Italy',
    home_team: 'Inter Milan',
    away_team: 'Napoli',
    home_team_logo: 'https://media.api-sports.io/teams/505.png',
    away_team_logo: 'https://media.api-sports.io/teams/492.png',
    kickoff_time: '2024-01-15T20:45:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 2.15, x: 3.40, two: 3.20 },
      over_under_2_5: { over: 1.93, under: 1.87 },
      both_teams_to_score: { yes: 1.80, no: 2.00 }
    }
  },
  {
    id: '11',
    fixture_id: 1011,
    league: 'Bundesliga',
    country: 'Germany',
    home_team: 'RB Leipzig',
    away_team: 'Union Berlin',
    home_team_logo: 'https://media.api-sports.io/teams/173.png',
    away_team_logo: 'https://media.api-sports.io/teams/181.png',
    kickoff_time: '2024-01-15T17:00:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 1.70, x: 3.70, two: 5.00 },
      over_under_2_5: { over: 2.00, under: 1.82 },
      both_teams_to_score: { yes: 1.90, no: 1.90 }
    }
  },
  {
    id: '12',
    fixture_id: 1012,
    league: 'Ligue 1',
    country: 'France',
    home_team: 'Lyon',
    away_team: 'Monaco',
    home_team_logo: 'https://media.api-sports.io/teams/564.png',
    away_team_logo: 'https://media.api-sports.io/teams/566.png',
    kickoff_time: '2024-01-15T19:00:00Z',
    status: 'scheduled',
    odds: {
      one_x_two: { one: 2.10, x: 3.40, two: 3.30 },
      over_under_2_5: { over: 1.90, under: 1.90 },
      both_teams_to_score: { yes: 1.75, no: 2.05 }
    }
  }
];
void _unused;
