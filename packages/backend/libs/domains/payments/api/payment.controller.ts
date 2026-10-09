import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
} from '@nestjs/microservices';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { KafkaConsumerService } from '@app/infrastructure/kafka/kafka-consumer.service';
import { PaymentService } from '../application/payment.service';
import { PostPaymentParamsDto } from './payment.dto';

@Controller()
export class PaymentController {
  private readonly l = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly outboxService: OutboxService,
    private readonly kafkaConsumerService: KafkaConsumerService,
  ) {}

  @EventPattern('payments.requests')
  async handlePayment(
    @Payload() data: PostPaymentParamsDto,
    @Ctx() context: KafkaContext,
  ) {
    return await this.kafkaConsumerService.consume({
      spanName: 'PaymentConsumer.handlePayment',
      data,
      context,
      responseTopic: KafkaTopicGroup.PAYMENTS_RESPONSES,
      dlqTopic: KafkaTopicGroup.PAYMENTS_DLQ,
      handler: async ({ data, activeSpan, responseTopic }) => {
        return await this.paymentService.executePayment({
          params: data,
          topic: responseTopic,
          activeSpan,
        });
      },
    });
  }
}
