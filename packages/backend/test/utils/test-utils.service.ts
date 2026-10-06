import { INestApplication, Injectable } from '@nestjs/common';
import request from 'supertest';

@Injectable()
export class TestUtilsService {
  public async checkMethodErr(
    input: any,
    expectedError: any,
    method: (...args: any[]) => any,
  ) {
    try {
      await method(input);
    } catch (error) {
      expect(error).toMatchObject(expectedError);
    }
  }

  public async checkReqError(
    reqPath: string,
    app: INestApplication,
    data: any,
    error: string | undefined, // | 'VALIDATION_ERROR'
    method: 'post' | 'put' | 'get' | 'delete' = 'post',
  ) {
    let formedRequest: any = request(app.getHttpServer());

    switch (method) {
      case 'post':
        formedRequest = formedRequest.post(reqPath);
        break;
      case 'put':
        formedRequest = formedRequest.put(reqPath);
        break;
      case 'get':
        formedRequest = formedRequest.get(reqPath);
        break;
      case 'delete':
        formedRequest = formedRequest.delete(reqPath);
        break;
    }

    const errorBody = (await formedRequest.send(data).expect(400)).body;

    if (error === 'VALIDATION_ERROR') {
      expect(errorBody.statusCode).toBe(400);
      expect(errorBody.error.error).toBe('Bad Request');
      expect(errorBody.message.length).toBeGreaterThanOrEqual(1);
    } else {
      expect(errorBody.error.name).toBe(error);
    }

    return errorBody;
  }
}

/**
 * Asserts an RFC 9457 Problem Details response (the shape `AllExceptionsFilter`
 * emits) - `errorName` is the AppError class name at the end of `type`.
 */
export function expectProblem(
  body: { type?: string; status?: number; title?: string; detail?: string },
  { status, errorName }: { status: number; errorName?: string },
): void {
  expect(body.status).toBe(status);
  if (errorName) expect(body.type).toMatch(new RegExp(`/errors/${errorName}$`));
}
