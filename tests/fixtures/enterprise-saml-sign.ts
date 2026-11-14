import { inflateRawSync } from 'node:zlib'
import { SignedXml } from 'xml-crypto'
function signXml(xml: string, xpath: string, location: { reference: string, action: 'after' }, options: { privateKey: string, publicCert: string }) {
  const signature = new SignedXml({ privateKey: options.privateKey, publicCert: options.publicCert, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256', canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' })
  signature.addReference({ xpath, transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' })
  signature.computeSignature(xml, { location })
  return signature.getSignedXml()
}

/** Public, non-production test credentials only. */
export const samlTestKey = await Bun.file(new URL('./enterprise-saml-test-key.pem', import.meta.url)).text()
export const samlTestCert = await Bun.file(new URL('./enterprise-saml-test-cert.pem', import.meta.url)).text()
export function samlRequestId(location: string) {
  const xml = inflateRawSync(Buffer.from(new URL(location).searchParams.get('SAMLRequest')!, 'base64')).toString()
  const id = /\bID="([^"]+)"/.exec(xml)?.[1]
  if (!id) throw new Error('Signed SAML AuthnRequest must carry a request ID')
  return id
}
export function signedSamlResponse(requestId: string, issuer: string, entityId: string, callback: string, mode = 'signed') {
  const now = new Date().toISOString(), expires = new Date(Date.now() + 120000).toISOString()
  const signing = { privateKey: samlTestKey, publicCert: samlTestCert, signatureAlgorithm: 'sha256' as const, digestAlgorithm: 'sha256' }
  let assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion-${crypto.randomUUID()}" Version="2.0" IssueInstant="${now}"><saml:Issuer>${issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">persistent-agent</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${mode === 'recipient' ? 'https://attacker.example.test/acs' : callback}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${new Date(Date.now() - 1000).toISOString()}" NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${mode === 'audience' ? 'foreign-audience' : entityId}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${now}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>agent@example.test</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`
  if (mode !== 'unsigned') assertion = signXml(assertion, "/*[local-name()='Assertion']", { reference: "/*[local-name()='Assertion']/*[local-name()='Issuer']", action: 'after' }, signing)
  let xml = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response-${crypto.randomUUID()}" Version="2.0" IssueInstant="${now}" Destination="${callback}" InResponseTo="${requestId}"><saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`
  if (mode !== 'unsigned') xml = signXml(xml, "/*[local-name()='Response']", { reference: "/*[local-name()='Response']/*[local-name()='Issuer']", action: 'after' }, signing)
  return Buffer.from(xml).toString('base64')
}
