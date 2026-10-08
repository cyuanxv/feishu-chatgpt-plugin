import type { Pool } from 'pg';
import { PostgresDocumentWriteAccess,type DocumentWriteAccess } from './document-write-access.js';
import type { TokenStore } from './vault.js';
export type TaskWriteAccess=DocumentWriteAccess;
/** Separate capability policy; neither calendar.read nor docs.write can authorize task creation. */
export class PostgresTaskWriteAccess extends PostgresDocumentWriteAccess {
 constructor(db:Pick<Pool,'query'>,tokens:Pick<TokenStore,'snapshot'>,resource:string){super(db,tokens,resource,'create_task');}
}
