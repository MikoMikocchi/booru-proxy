import { Module, Global } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { ValidationService } from './validation.service'

@Global()
@Module({
  imports: [ConfigModule],
  providers: [ValidationService],
  exports: [ValidationService],
})
export class ValidationModule {}
