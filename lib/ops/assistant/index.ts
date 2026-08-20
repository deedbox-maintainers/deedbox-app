// The help assistant (schema change 0036): a grounded help Q&A over the
// engine + firm knowledge base — lexical retrieval with an honest
// confidence floor, the model behind a deployment seam, guardrails on both
// sides of it, code-computed access caveats, and append-only telemetry.

export { setAssistantModelService, assistantModelService } from './seam'
export type { AssistantModelService } from './seam'
export { askAssistant } from './ask'
export type { AskResult } from './ask'
export { screenUserMessage, validateAnswer, REFUSAL_USAGE } from './guardrails'
export { confidenceFor, searchHelpInTx } from './retrieval'
export type { Confidence, RetrievedChunk } from './retrieval'
export { ASSISTANT_SYSTEM, buildUserText, parseModelOutput } from './prompt'
export {
  createAssistantArticle,
  updateAssistantArticle,
  setAssistantArticleStatus,
} from './articles'
export { reviewAssistantGap } from './gaps'
export { recordAssistantFeedback } from './feedback'
export type { FeedbackRating } from './feedback'
export { starterQuestions } from './starters'
