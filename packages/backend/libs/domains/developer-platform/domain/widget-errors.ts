import { AppError, ErrorArea } from '@app/common/errors/error.types';

/**
 * The widget's problem codes (contracts/http-*.md, `WIDGET_ERROR_CODES` of the contract package; a contract e2e compares
 * the two lists). Every widget error is a `WidgetError`: the S54 filter turns it into problem+json with `code` and
 * `requestId`; no controller builds an error body. Codes shared with the public API (`validation_failed`,
 * `payload_too_large`, ...) are raised as `ApiError` where the S42 pipe already does.
 */
export const WIDGET_ERROR_CATALOGUE = {
  origin_invalid: [422, 'Origin invalid'],
  origin_not_allowed: [403, 'Origin not allowed'],
  widget_site_not_found: [404, 'Widget site not found'],
  shop_not_found: [404, 'Shop not found'],
  widget_disabled: [410, 'Widget disabled'],
  identity_token_invalid: [401, 'Identity token invalid'],
  widget_token_invalid: [401, 'Widget token invalid'],
  site_limit_reached: [422, 'Site limit reached'],
  site_version_conflict: [409, 'Site version conflict'],
  featured_product_invalid: [422, 'Featured product invalid'],
  rotation_in_progress: [409, 'Rotation in progress'],
  rotation_not_in_progress: [409, 'Rotation not in progress'],
  invalid_cursor: [400, 'Invalid cursor'],
  unsupported_media_type: [415, 'Unsupported media type'],
  service_unavailable: [503, 'Service unavailable'],
} as const;

export type WidgetErrorCode = keyof typeof WIDGET_ERROR_CATALOGUE;

export class WidgetError extends AppError {
  declare code: WidgetErrorCode;

  constructor(
    code: WidgetErrorCode,
    detail?: string,
    options: {
      extensions?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ) {
    const [status, title] = WIDGET_ERROR_CATALOGUE[code];
    super({
      code,
      status,
      title,
      detail: detail ?? title,
      area: status >= 500 ? ErrorArea.TRANSIENT : ErrorArea.DOMAIN,
      extensions: options.extensions,
      headers: options.headers,
    });
  }
}

export const siteNotFound = (): WidgetError =>
  new WidgetError('widget_site_not_found', 'No widget site matches.');
export const originNotAllowed = (): WidgetError =>
  new WidgetError('origin_not_allowed', 'This origin is not registered.');
export const widgetDisabled = (): WidgetError =>
  new WidgetError('widget_disabled', 'This widget is switched off.');
export const identityTokenInvalid = (): WidgetError =>
  new WidgetError('identity_token_invalid', 'The identity token is invalid.');
export const widgetTokenInvalid = (): WidgetError =>
  new WidgetError('widget_token_invalid', 'The widget token is invalid.');
export const serviceUnavailable = (): WidgetError =>
  new WidgetError('service_unavailable', 'The service is unavailable.');
