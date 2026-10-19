export class Store {
  constructor(db) { this.db=db; }
  async state(key) { const row=await this.db.prepare('SELECT value FROM state WHERE key=?').bind(key).first(); return row?JSON.parse(row.value):null; }
  async set(key,value) { await this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(value)).run(); }
  async rows(table) { if(!['messages','issues'].includes(table)) throw new Error('非法表名'); return (await this.db.prepare(`SELECT payload FROM ${table}`).all()).results.map(r=>JSON.parse(r.payload)); }
  async putMessages(messages, hash) {
    for(let offset=0;offset<messages.length;offset+=40) {
      const batch=await Promise.all(messages.slice(offset,offset+40).map(async m=>this.db.prepare('INSERT INTO messages(id,chat_id,created_at,updated_at,payload,hash) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload,hash=excluded.hash').bind(m.id,m.chat_id,m.created_at,m.updated_at,JSON.stringify(m),await hash(JSON.stringify(m)))));
      if(batch.length) await this.db.batch(batch);
    }
  }
  async putIssues(issues) {
    for(let offset=0;offset<issues.length;offset+=40) {
      const batch=issues.slice(offset,offset+40).map(i=>this.db.prepare('INSERT INTO issues(id,root_id,status,created_at,updated_at,payload) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload=excluded.payload').bind(i.id,i.root_id,i.status,i.created_at,i.updated_at,JSON.stringify(i)));
      if(batch.length) await this.db.batch(batch);
    }
  }
  async unanalyzed() { return (await this.db.prepare('SELECT payload FROM messages WHERE analyzed_hash IS NULL OR analyzed_hash<>hash ORDER BY created_at,id').all()).results.map(r=>JSON.parse(r.payload)); }
  async markAnalyzed(ids) {
    for(let i=0;i<ids.length;i+=50) {
      const slice=ids.slice(i,i+50);if(!slice.length) continue;
      await this.db.prepare(`UPDATE messages SET analyzed_hash=hash WHERE id IN (${slice.map(()=>'?').join(',')})`).bind(...slice).run();
    }
  }
  async lock(now) {
    const owner=crypto.randomUUID();
    const result=await this.db.prepare("INSERT INTO state(key,value) VALUES('lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(json_extract(state.value,'$.expires') AS INTEGER) < ?").bind(JSON.stringify({owner,expires:now+600000}),now).run();
    return result.meta.changes===1?owner:null;
  }
  async unlock(owner) { await this.db.prepare("DELETE FROM state WHERE key='lock' AND json_extract(value,'$.owner')=?").bind(owner).run(); }
  async event(type,detail) { await this.db.prepare('INSERT INTO events(time,type,detail) VALUES(?,?,?)').bind(new Date().toISOString(),type,JSON.stringify(detail)).run(); }
  async delivery(id) { return this.db.prepare('SELECT * FROM deliveries WHERE id=?').bind(id).first(); }
  async pending() { return (await this.db.prepare("SELECT * FROM deliveries WHERE state IN ('queued','failed','sending','unknown') ORDER BY scheduled_at,page").all()).results; }
  async queue({id,slot,scheduled_at,card,page,total_pages,target}) {
    await this.db.prepare('INSERT OR IGNORE INTO deliveries(id,slot,scheduled_at,target_chat_id,page,total_pages,uuid,card,state,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,slot,scheduled_at,target,page,total_pages,crypto.randomUUID(),JSON.stringify(card),'queued',new Date().toISOString()).run();
  }
  async mark(id,state,messageId=null,error=null) { await this.db.prepare("UPDATE deliveries SET state=?,message_id=COALESCE(?,message_id),error=?,updated_at=?,attempts=attempts+CASE WHEN ?='sending' THEN 1 ELSE 0 END WHERE id=?").bind(state,messageId,error,new Date().toISOString(),state,id).run(); }
}
