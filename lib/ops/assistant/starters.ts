// Route-aware starter questions. Pure function — the help page
// keys off the optional from-route its links carry.

const DEFAULTS = [
  'How do I create a new matter?',
  'How do I record time on a matter?',
  'How do I record a client-money receipt?',
  'How do I upload a document to a matter?',
]

const RULES: { test: RegExp; questions: string[] }[] = [
  {
    test: /^\/matters\/[^/]+\/documents/,
    questions: [
      'How do I upload a document to this matter?',
      'How do I generate a document from a template?',
      'How do I compare two versions of a document?',
      'How do I share a document with someone outside the firm?',
    ],
  },
  {
    test: /^\/matters\/[^/]+\/money/,
    questions: [
      'How do I record a receipt for this matter?',
      'How do I pay client money out?',
      'What is an earmark?',
      'Why was a payment refused?',
    ],
  },
  {
    test: /^\/matters\/[^/]+\/billing/,
    questions: [
      'How do I draft a bill from this work in progress?',
      'How do I apply a write-down?',
      'How do I issue a bill?',
      'How do I record a payment on a bill?',
    ],
  },
  {
    test: /^\/matters\/[^/]+/,
    questions: [
      'How do I add a note to this matter?',
      'How do I record time on this matter?',
      'How do I close a matter?',
      'How do I give a client portal access?',
    ],
  },
  {
    test: /^\/matters/,
    questions: [
      'How do I create a new matter?',
      'How do I find a matter?',
      'What do the matter statuses mean?',
      'How do I close a matter?',
    ],
  },
  {
    test: /^\/money/,
    questions: [
      'How do I record a client-money receipt?',
      'How do I pay client money out?',
      'How do I reconcile the bank statement?',
      'What happens when a payment is refused?',
    ],
  },
  {
    test: /^\/billing/,
    questions: [
      'How do I record a time entry?',
      'How do I draft and issue a bill?',
      'How do payment reminders work?',
      'How do I set up an instalment arrangement?',
    ],
  },
  {
    test: /^\/intake/,
    questions: [
      'How do I record a new enquiry?',
      'How do I convert an intake into a matter?',
      'How do I run a conflict check?',
      'What happens to duplicate-looking clients?',
    ],
  },
  {
    test: /^\/parties/,
    questions: [
      'How do I add a new client?',
      'How do I merge duplicate records?',
      'How do I give a client portal access?',
      'How do I fix a misspelt name?',
    ],
  },
  {
    test: /^\/reports/,
    questions: [
      'How do I run a report?',
      'How do I save a shaped report?',
      'How do I schedule a report to send itself?',
      'Why do my figures differ from a colleague?',
    ],
  },
  {
    test: /^\/settings|^\/security/,
    questions: [
      'How do I add a staff member?',
      'How do I change what a role can do?',
      'How do I edit firm settings?',
      'How do I import data from another system?',
    ],
  },
]

export function starterQuestions(route: string | null | undefined): string[] {
  if (!route) return DEFAULTS
  for (const r of RULES) if (r.test.test(route)) return r.questions
  return DEFAULTS
}
