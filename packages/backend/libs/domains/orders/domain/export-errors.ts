import { HttpStatus } from '@nestjs/common';
import { AppError, ErrorArea } from '@app/common/errors';

/** Problem codes of the export routes (S12 contracts/http.md). Another shop's export is `export_not_found`. */
type Params = ConstructorParameters<typeof AppError>[0];

const domainError = (
  status: HttpStatus,
  code: string,
  title: string,
  detail: string,
  extra: Partial<Params> = {},
): Params => ({
  status,
  code,
  title,
  detail,
  area: ErrorArea.DOMAIN,
  ...extra,
});

export class ExportNotFoundError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.NOT_FOUND,
        'export_not_found',
        'Not found',
        'Export not found.',
      ),
    );
  }
}

export class ExportNotReadyError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'export_not_ready',
        'Conflict',
        'The export file is not ready yet.',
      ),
    );
  }
}

export class ExportExpiredError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.GONE,
        'export_expired',
        'Gone',
        'The export file has expired. Start a new export.',
      ),
    );
  }
}

export class ExportNotCancellableError extends AppError {
  constructor() {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'export_not_cancellable',
        'Conflict',
        'The export has already finished and cannot be cancelled.',
      ),
    );
  }
}

export class ExportAlreadyActiveError extends AppError {
  constructor(readonly activeExportId: string) {
    super(
      domainError(
        HttpStatus.CONFLICT,
        'export_already_active',
        'Conflict',
        'An export of this shop is already running.',
        { extensions: { activeExportId } },
      ),
    );
  }
}
