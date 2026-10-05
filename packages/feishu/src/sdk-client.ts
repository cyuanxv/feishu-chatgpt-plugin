import { AppType, Client, Domain, defaultHttpInstance, type ClientAssertionProvider, type HttpInstance, type Logger } from '@larksuiteoapi/node-sdk';

export const silentSdkLogger: Logger = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, trace: () => {} };
export interface SafeSdkConfiguration {
  appId: string;
  appSecret?: string;
  clientAssertionProvider?: ClientAssertionProvider;
  domain: 'feishu' | 'lark';
  /** Explicit dependency injection for contract tests or an operator-reviewed transport. */
  httpInstance?: HttpInstance;
}
/** Does not read environment variables, files or credentials. Callers must explicitly supply authorized configuration. */
export function createSafeSdkClient(config: SafeSdkConfiguration): Client {
  // A dedicated HTTP client prevents unbounded requests and follows no redirects to other hosts.
  let http: HttpInstance;
  if (config.httpInstance) http = config.httpInstance;
  else {
    const axios = defaultHttpInstance.create({ timeout: 15_000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, maxBodyLength: 256 * 1024 });
    axios.interceptors.response.use(response => response.data);
    // The SDK's HttpInstance returns the body. Axios's declared response type does not model response interceptors.
    http = axios as unknown as HttpInstance;
  }
  return new Client({ appId: config.appId, ...(config.appSecret ? { appSecret: config.appSecret } : {}), ...(config.clientAssertionProvider ? { clientAssertionProvider: config.clientAssertionProvider } : {}), domain: config.domain === 'feishu' ? Domain.Feishu : Domain.Lark, appType: AppType.SelfBuild, disableTokenCache: true, logger: silentSdkLogger, httpInstance: http });
}
