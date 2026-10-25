@Controller('shops/:shopId/things')
export class Bad {
  @Get()
  list(@Param('shopId') shopId: string) { return 1; }
  @ShopScoped('x')
  @Post()
  ok(@Body() b: any) { return b.shopId; }
  @Post()
  badbody(@Body() b: any) { return b.shopId; }
}
@Controller()
export class Bad2 {
  @Get('shops/:shopId/orders')
  list2() { return 1; }
  @ShopScoped('x')
  @Get('shops/:shopId/ok')
  ok2() { return 1; }
}
