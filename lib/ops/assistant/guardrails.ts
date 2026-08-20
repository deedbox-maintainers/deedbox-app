// Assistant guardrails — defence in depth around the model, in two
// layers:
//
//   screenUserMessage()  — pre-flight. The most dangerous asks (reveal the
//     system prompt / secrets / keys, run SQL, show another person's matter)
//     get a deterministic refusal and NEVER reach the model. Softer
//     "do X for me" / "ignore your instructions" asks are flagged; the
//     model is instructed to refuse those itself, with the steps.
//   validateAnswer() — post-generation. Redacts secret-looking strings,
//     scrubs trust-compliance verdicts into the deferral, and disclaims
//     false "I did it for you" claims, before the answer is ever shown.
//
// Pure functions: no database, no network.

export interface ScreenResult {
  flags: string[]
  hardRefuse: boolean
  refusalText?: string
}

export const REFUSAL_USAGE =
  'I can only help with how to use the application. I cannot do that — but I am happy to explain the steps so you can do it yourself, or point you to the right screen.'

const HARD_PATTERNS: { flag: string; re: RegExp }[] = [
  {
    flag: 'system_prompt_exfil',
    re: /\b(system|developer)\s+prompt\b|\byour\s+(instructions|rules|prompt)\b|\bprompt\s+(you\s+were\s+given|text)\b/i,
  },
  {
    flag: 'secret_exfil',
    re: /\b(service[_ ]?role|api[_ ]?key|secret\s+key|anon\s+key|access\s+token|connection\s+string|env(ironment)?\s+variable|password)\b/i,
  },
  {
    flag: 'sql_exec',
    re: /\b(run|execute|exec)\b[^.]*\bsql\b|\b(select|insert|update|delete|drop|alter|create)\s+(\*|from|into|table|role|policy)\b/i,
  },
  {
    flag: 'cross_client',
    re: /\b(another|other|different|someone\s+else'?s?)\s+(lawyer|user|client|matter|firm)\b|\bnot\s+(my|mine)\b.*\bmatter\b/i,
  },
]

const SOFT_PATTERNS: { flag: string; re: RegExp }[] = [
  {
    flag: 'ignore_instructions',
    re: /\bignore\s+(your|all|previous|prior)\b|\bdisregard\s+(your|the)\b|\bpretend\s+(you|to)\b|\bact\s+as\b|\bjailbreak\b/i,
  },
  {
    flag: 'mutation_request',
    re: /\b(create|delete|post|send|reverse|reconcile|transfer|withdraw|approve|submit|lodge|update|invoice|email|move\s+money|write\s*-?\s*off)\b.*\b(for\s+me|it|this|the\s+\w+|anyway)\b/i,
  },
]

export function screenUserMessage(text: string): ScreenResult {
  const flags: string[] = []
  for (const p of HARD_PATTERNS) if (p.re.test(text)) flags.push(p.flag)
  if (flags.length > 0) {
    return { flags, hardRefuse: true, refusalText: REFUSAL_USAGE }
  }
  for (const p of SOFT_PATTERNS) if (p.re.test(text)) flags.push(p.flag)
  return { flags, hardRefuse: false }
}

const TRUST_DEFERRAL =
  'Whether a particular trust transaction is permitted is a professional judgment — please confirm with the principal or responsible trust-account supervisor before posting. I can only show you where the screen is and what each field means.'

// Assertions the assistant must NEVER make. Each match is replaced whole.
const FORBIDDEN_ASSERTIONS: RegExp[] = [
  /you\s+(do\s+not|don'?t)\s+need\s+(an?\s+)?authorit/i,
  /(this|that|it|these\s+funds?)\s+(is|are)\s+not\s+trust\s+money/i,
  /you\s+can\s+safely\s+(move|transfer|withdraw|pay|disburse|use)/i,
  /(this|that|the)\s+(transfer|transaction|withdrawal|payment|disbursement)\s+(is|would\s+be)\s+(compliant|permitted|allowed|fine|ok)/i,
  /(safe|fine|ok(ay)?)\s+to\s+(move|transfer|withdraw|disburse|pay)/i,
  /(is|are|it'?s)\s+(not\s+)?reportable/i,
  /you\s+(do\s+not|don'?t)\s+need\s+to\s+report/i,
]

const FALSE_ACTION =
  /\bI(?:\s+have|\s*['’]ve|\s+just)?\s+(created|posted|sent|deleted|updated|reversed|transferred|saved|submitted|lodged|recorded|booked|reconciled|approved|invoiced|added)\b|\bdone\s+(it|that)\s+for\s+you\b|\bI(?:\s*['’]ll|\s+will)\s+(create|post|send|delete|update|reverse|transfer|submit|lodge|approve|invoice)\s+(it|the|this|that)\b/i

const SECRET_LIKE: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /postgres(?:ql)?:\/\/[^\s'"]+/gi,
  /\b[a-f0-9]{40,}\b/gi, // long hex (tokens / role passwords)
]

const ACTION_DISCLAIMER =
  '\n\n(To be clear: I cannot perform that action for you — the steps above are for you to carry out.)'

export interface ValidationResult {
  answer: string
  flags: string[]
  refused: boolean
}

export function validateAnswer(input: string, alreadyRefused: boolean): ValidationResult {
  let answer = input
  const flags: string[] = []

  for (const re of SECRET_LIKE) {
    if (re.test(answer)) {
      answer = answer.replace(re, '[redacted]')
      if (!flags.includes('secret_redacted')) flags.push('secret_redacted')
    }
  }

  for (const re of FORBIDDEN_ASSERTIONS) {
    if (re.test(answer)) {
      answer = answer.replace(re, TRUST_DEFERRAL)
      if (!flags.includes('trust_verdict_scrubbed')) flags.push('trust_verdict_scrubbed')
    }
  }

  if (FALSE_ACTION.test(answer)) {
    flags.push('false_action_claim')
    if (!answer.includes('cannot perform that action')) answer += ACTION_DISCLAIMER
  }

  return { answer: answer.trim(), flags, refused: alreadyRefused }
}
