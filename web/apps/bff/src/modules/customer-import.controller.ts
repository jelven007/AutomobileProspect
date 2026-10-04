import {
  Controller,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { CustomerImportReport } from '@leadops/types';
import { Roles } from '../common/auth';
import { CustomerImportService } from './customer-import.service';

@Controller('customer')
@Roles('admin', 'operator')
export class CustomerImportController {
  constructor(
    @Inject(CustomerImportService) private readonly imports: CustomerImportService,
  ) {}

  @Post('import')
  async importXlsx(@Req() req: unknown): Promise<CustomerImportReport> {
    const request = req as {
      isMultipart?: () => boolean;
      file?: () => Promise<unknown>;
    };
    if (!request.isMultipart?.()) {
      throw new HttpException({ code: 40001, message: 'multipart_required' }, HttpStatus.BAD_REQUEST);
    }
    const file = await request.file?.() as
      | { filename: string; file: Readable }
      | undefined;
    if (!file) {
      throw new HttpException({ code: 40001, message: 'file_required' }, HttpStatus.BAD_REQUEST);
    }
    if (!file.filename.toLowerCase().endsWith('.xlsx')) {
      throw new HttpException({ code: 40002, message: 'only_xlsx_supported' }, HttpStatus.BAD_REQUEST);
    }
    return this.imports.importFile(file.filename, file.file);
  }
}
