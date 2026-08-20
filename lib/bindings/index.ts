// The deployment bindings: the three seams the core exposes, bound to
// real services from the environment at server start
// (instrumentation.ts). Anything unconfigured stays unbound — the seams
// keep refusing loudly and typed, which is the designed posture: a
// half-configured installation tells the truth about itself.

import { setOutboundTransport } from '@/lib/jobs/registry'
import { setSignInService } from '@/lib/auth/seam'
import { setIntakeDocumentStore } from '@/lib/ops/interface'
import { setDocumentByteStore, setDocumentByteFetch } from '@/lib/ops/documents/store'
import { setM365Service } from '@/lib/ops/m365/seam'
import { setAssistantModelService } from '@/lib/ops/assistant/seam'
import { hostedM365Service } from './m365'
import { hostedAssistantModel } from './assistant'
import { emailTransport } from './email'
import { hostedSignInService } from './signin'
import { hostedDocumentStore, hostedByteStore, hostedByteFetch } from './documents'
import { gotenbergConfigFromEnv, gotenbergHtmlToPdf } from './pdf'

export { emailTransport, type EmailTransportConfig, type HttpPost } from './email'
export { gotenbergHtmlToPdf, gotenbergConfigFromEnv, type GotenbergConfig } from './pdf'
export { hostedSignInService, type HostedSignInConfig } from './signin'
export { hostedDocumentStore, type HostedDocumentStoreConfig, type HttpPut } from './documents'

export interface BindingSummary {
  outboundTransport: boolean
  signInService: boolean
  intakeDocumentStore: boolean
}

/**
 * Read the deployment's environment and bind what it configures:
 * - RESEND_API_KEY + DEEDBOX_MAIL_FROM        → the outbound email transport
 * - DEEDBOX_PLATFORM_URL + DEEDBOX_PLATFORM_ANON_KEY    → the sign-in service
 * - DEEDBOX_PLATFORM_URL + DEEDBOX_PLATFORM_SERVICE_KEY → the document store
 *   (bucket from DEEDBOX_DOCUMENT_BUCKET, default 'matter-documents')
 */
export function bindFromEnvironment(env: NodeJS.ProcessEnv = process.env): BindingSummary {
  const summary: BindingSummary = {
    outboundTransport: false,
    signInService: false,
    intakeDocumentStore: false,
  }

  if (env.RESEND_API_KEY && env.DEEDBOX_MAIL_FROM) {
    // the converter rides along when configured; without it the transport
    // still sends everything except document-promising purposes (typed)
    const gotenberg = gotenbergConfigFromEnv()
    setOutboundTransport(
      emailTransport({
        apiKey: env.RESEND_API_KEY,
        from: env.DEEDBOX_MAIL_FROM,
        htmlToPdf: gotenberg ? gotenbergHtmlToPdf(gotenberg) : undefined,
      }),
    )
    summary.outboundTransport = true
  }
  if (env.DEEDBOX_PLATFORM_URL && env.DEEDBOX_PLATFORM_ANON_KEY) {
    setSignInService(
      hostedSignInService({ url: env.DEEDBOX_PLATFORM_URL, apiKey: env.DEEDBOX_PLATFORM_ANON_KEY }),
    )
    summary.signInService = true
  }
  if (env.DEEDBOX_PLATFORM_URL && env.DEEDBOX_PLATFORM_SERVICE_KEY) {
    const storeConfig = {
      url: env.DEEDBOX_PLATFORM_URL,
      serviceKey: env.DEEDBOX_PLATFORM_SERVICE_KEY,
      bucket: env.DEEDBOX_DOCUMENT_BUCKET || undefined,
    }
    setIntakeDocumentStore(hostedDocumentStore(storeConfig))
    // the documents module's staff-upload and read-back paths ride the same service
    setDocumentByteStore(hostedByteStore(storeConfig))
    setDocumentByteFetch(hostedByteFetch(storeConfig))
    summary.intakeDocumentStore = true
  }
  if (env.M365_CLIENT_ID && env.M365_CLIENT_SECRET && env.M365_TENANT_ID && env.M365_REDIRECT_URI) {
    setM365Service(
      hostedM365Service({
        clientId: env.M365_CLIENT_ID,
        clientSecret: env.M365_CLIENT_SECRET,
        tenantId: env.M365_TENANT_ID,
        redirectUri: env.M365_REDIRECT_URI,
      }),
    )
    console.log('[bindings] microsoft 365: bound')
  } else {
    console.log('[bindings] microsoft 365: UNBOUND')
  }
  if (env.DEEDBOX_ASSISTANT_API_KEY) {
    setAssistantModelService(
      hostedAssistantModel({
        apiKey: env.DEEDBOX_ASSISTANT_API_KEY,
        model: env.DEEDBOX_ASSISTANT_MODEL || undefined,
      }),
    )
    console.log('[bindings] help assistant model: bound')
  } else {
    console.log('[bindings] help assistant model: UNBOUND (help articles still available)')
  }

  // one honest line per seam at boot; never a secret
  console.log(
    `[bindings] outbound transport: ${summary.outboundTransport ? 'bound (email)' : 'UNBOUND'} · ` +
      `sign-in service: ${summary.signInService ? 'bound (hosted)' : 'UNBOUND'} · ` +
      `intake document store: ${summary.intakeDocumentStore ? 'bound (hosted storage)' : 'UNBOUND'}`,
  )
  return summary
}
