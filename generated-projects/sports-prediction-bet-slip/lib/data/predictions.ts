/**
 * DEPRECATED — Do not use samplePredictions.
 * Predictions are generated in real-time from LiveScore 6 data by GET /api/predictions.
 */
import { Prediction } from '@/lib/types/match';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const samplePredictions: Prediction[] = [] as any[];

const _unusedPredictions = [
  {
    id: 'pred-1',
    match_id: '1',
    prediction_type: '1X2',
    suggested_pick: 'Draw',
    confidence: 62,
    risk_level: 'medium',
    odds: 3.40,
    reasoning: 'Both teams in good form. Historical head-to-head suggests competitive match.',
    ai_analysis: 'Manchester United and Liverpool are evenly matched. United\'s strong home record vs Liverpool\'s solid away performance suggests a draw is likely. Consider backing the X for value.'
  },
  {
    id: 'pred-2',
    match_id: '1',
    prediction_type: 'OVER_UNDER_2_5',
    suggested_pick: 'Over 2.5',
    confidence: 71,
    risk_level: 'low',
    odds: 1.95,
    reasoning: 'Both teams average 2.3+ goals per game. High-scoring fixture expected.',
    ai_analysis: 'This is a classic attacking matchup. Both teams have scored in their last 5 games. Over 2.5 is the safer bet here.'
  },
  {
    id: 'pred-3',
    match_id: '1',
    prediction_type: 'BTTS',
    suggested_pick: 'Yes',
    confidence: 68,
    risk_level: 'low',
    odds: 1.72,
    reasoning: 'Both teams have strong attacking records and weak defenses.',
    ai_analysis: 'Both teams to score has landed in 4 of their last 5 meetings. Solid low-risk pick.'
  },
  {
    id: 'pred-4',
    match_id: '1',
    prediction_type: 'CORRECT_SCORE',
    suggested_pick: '2-2',
    confidence: 45,
    risk_level: 'high',
    odds: 8.50,
    reasoning: 'High odds due to rarity, but both teams capable of scoring multiple goals.',
    ai_analysis: 'Correct score bets are high-risk. 2-2 is possible but unlikely. Only bet if you can afford the loss.'
  },
  {
    id: 'pred-5',
    match_id: '2',
    prediction_type: '1X2',
    suggested_pick: 'Home Win',
    confidence: 58,
    risk_level: 'medium',
    odds: 2.05,
    reasoning: 'Arsenal strong at home. Chelsea inconsistent away.',
    ai_analysis: 'Arsenal\'s home advantage is significant. They\'ve won 6 of last 8 at Emirates. Chelsea\'s away form is mixed. Slight edge to Arsenal.'
  },
  {
    id: 'pred-6',
    match_id: '2',
    prediction_type: 'OVER_UNDER_2_5',
    suggested_pick: 'Over 2.5',
    confidence: 65,
    risk_level: 'low',
    odds: 1.90,
    reasoning: 'Both teams average 2.1+ goals per match.',
    ai_analysis: 'Arsenal averages 2.4 goals at home, Chelsea 1.8 away. Over 2.5 is likely.'
  },
  {
    id: 'pred-7',
    match_id: '3',
    prediction_type: '1X2',
    suggested_pick: 'Home Win',
    confidence: 85,
    risk_level: 'low',
    odds: 1.50,
    reasoning: 'Manchester City dominant. Tottenham struggling. Clear favorites.',
    ai_analysis: 'City is in elite form. Tottenham has injury concerns. This is a strong home win pick. Low odds but high probability.'
  },
  {
    id: 'pred-8',
    match_id: '3',
    prediction_type: 'OVER_UNDER_1_5',
    suggested_pick: 'Over 1.5',
    confidence: 80,
    risk_level: 'low',
    odds: 1.30,
    reasoning: 'City averages 3+ goals per game.',
    ai_analysis: 'Manchester City will likely score multiple goals. Over 1.5 is almost certain.'
  },
  {
    id: 'pred-9',
    match_id: '4',
    prediction_type: '1X2',
    suggested_pick: 'Home Win',
    confidence: 72,
    risk_level: 'low',
    odds: 1.95,
    reasoning: 'Real Madrid leading 1-0 at halftime. Strong home record.',
    ai_analysis: 'Real Madrid is in control. Leading at halftime is a strong indicator. Home win is the most likely outcome.'
  },
  {
    id: 'pred-10',
    match_id: '4',
    prediction_type: 'OVER_UNDER_2_5',
    suggested_pick: 'Over 2.5',
    confidence: 58,
    risk_level: 'medium',
    odds: 1.88,
    reasoning: 'Already 1-0 at min 34. Second half usually more open.',
    ai_analysis: 'With 56 minutes left and Madrid leading, expect more goals. Over 2.5 is reasonable.'
  },
  {
    id: 'pred-11',
    match_id: '5',
    prediction_type: '1X2',
    suggested_pick: 'Draw',
    confidence: 55,
    risk_level: 'medium',
    odds: 3.30,
    reasoning: 'Juventus and AC Milan evenly matched. Recent head-to-head suggests draws.',
    ai_analysis: 'Both teams are mid-table. A draw is a realistic outcome. Good value at 3.30.'
  },
  {
    id: 'pred-12',
    match_id: '6',
    prediction_type: '1X2',
    suggested_pick: 'Home Win',
    confidence: 80,
    risk_level: 'low',
    odds: 1.60,
    reasoning: 'Bayern Munich is the strongest team in Bundesliga. Dortmund inconsistent.',
    ai_analysis: 'Bayern is clear favorites. Their home record is exceptional. Home win is the safest bet.'
  },
  {
    id: 'pred-13',
    match_id: '7',
    prediction_type: '1X2',
    suggested_pick: 'Home Win',
    confidence: 88,
    risk_level: 'low',
    odds: 1.40,
    reasoning: 'PSG is the strongest team in Ligue 1. Marseille is 10 points behind.',
    ai_analysis: 'PSG is heavily favored. Their attacking power is overwhelming. Home win is almost certain.'
  },
  {
    id: 'pred-14',
    match_id: '8',
    prediction_type: '1X2',
    suggested_pick: 'Home Win',
    confidence: 65,
    risk_level: 'medium',
    odds: 1.90,
    reasoning: 'Newcastle strong at home. Brighton solid but inconsistent away.',
    ai_analysis: 'Newcastle\'s home advantage is real. Brighton has won only 2 of last 10 away. Home win is likely.'
  },
  {
    id: 'pred-15',
    match_id: '9',
    prediction_type: '1X2',
    suggested_pick: 'Home Win',
    confidence: 75,
    risk_level: 'low',
    odds: 1.85,
    reasoning: 'Atletico Madrid won 3-1. Strong home performance.',
    ai_analysis: 'Atletico dominated. Home win was correct prediction. Strong defensive display.'
  },
  {
    id: 'pred-16',
    match_id: '10',
    prediction_type: '1X2',
    suggested_pick: 'Draw',
    confidence: 52,
    risk_level: 'medium',
    odds: 3.40,
    reasoning: 'Inter and Napoli are closely matched. Recent meetings have been tight.',
    ai_analysis: 'This is a classic Serie A battle. Both teams are strong. A draw offers good value.'
  },
  {
    id: 'pred-17',
    match_id: '11',
    prediction_type: '1X2',
    suggested_pick: 'Home Win',
    confidence: 68,
    risk_level: 'low',
    odds: 1.70,
    reasoning: 'RB Leipzig strong at home. Union Berlin solid but defensive.',
    ai_analysis: 'Leipzig\'s attacking play at home is strong. Union Berlin is defensively organized but limited in attack. Home win likely.'
  },
  {
    id: 'pred-18',
    match_id: '12',
    prediction_type: '1X2',
    suggested_pick: 'Away Win',
    confidence: 62,
    risk_level: 'medium',
    odds: 3.30,
    reasoning: 'Monaco in better form. Lyon inconsistent.',
    ai_analysis: 'Monaco has won 3 of last 5. Lyon\'s home record is mixed. Away win offers value at 3.30.'
  }
];
void _unusedPredictions;