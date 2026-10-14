import { Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { createValidationPipe } from '@app/common/exceptions-filter/validation-pipe';
import { OperationValidator } from '../domain/ports';
import { CreateProductDto, UpdateProductDto } from './dto';

/** The route DTOs run through the platform's validation pipe, so a batch operation meets exactly the route's rules. */
@Injectable()
export class DtoOperationValidator extends OperationValidator {
  private readonly pipe = createValidationPipe();

  createProduct(plain: Record<string, unknown>) {
    return this.validate(CreateProductDto, plain);
  }

  updateProduct(plain: Record<string, unknown>) {
    return this.validate(UpdateProductDto, plain);
  }

  private async validate<T extends object>(
    type: new () => T,
    plain: Record<string, unknown>,
  ): Promise<T> {
    return (await this.pipe.transform(plainToInstance(type, plain) as unknown, {
      type: 'body',
      metatype: type,
    })) as T;
  }
}
