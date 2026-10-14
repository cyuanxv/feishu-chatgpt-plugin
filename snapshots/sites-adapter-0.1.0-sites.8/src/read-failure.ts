import {AppError} from "./security.ts";
export class ReadFailure extends AppError {
  constructor(
    code: string,
    status: number,
    readonly provider_code?: number,
  ) {
    super(code, status);
  }
}
