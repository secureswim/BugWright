import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { db } from "@bugpilot/database";
import { assertToolAllowed, ToolRole } from "@bugpilot/policy";
import { projectRoot } from "./runtime.js";

type ServerName = "repository" | "git" | "runner" | "github";
function sanitizeInput(args:Record<string,unknown>){return Object.fromEntries(Object.entries(args).map(([key,value])=>typeof value==="string"&&value.length>240?[key,{redacted:true,chars:value.length,sha256:createHash("sha256").update(value).digest("hex").slice(0,16)}]:[key,value]));}
export class McpTools {
  private clients = new Map<ServerName, Client>();
  private taskId:string;private repoRoot:string;
  constructor(taskId:string,repoRoot:string){this.taskId=taskId;this.repoRoot=repoRoot;}

  async connect(names: ServerName[]) {
    const root = projectRoot();
    for (const name of names) {
      const source = path.join(root, "packages", "mcp", name, "src", "server.ts");
      const client = new Client({ name: `bugpilot-agent-${name}`, version: "0.1.0" });
      const params: StdioServerParameters = {
        command: process.execPath,
        args: ["--require",path.join(root,"scripts","windows-user-shim.cjs"),"--import","tsx",source],
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === "string")) as Record<string,string>, BUGPILOT_REPO_ROOT: this.repoRoot }
      };
      try{await client.connect(new StdioClientTransport(params));}catch(error){const detail=error instanceof Error?error.message:String(error);throw new Error(`MCP ${name} connection failed: ${detail}`,{cause:error});}
      this.clients.set(name, client);
    }
  }

  async call(role:ToolRole,server: ServerName, name: string, args: Record<string, unknown> = {},iteration=0) {
    try{assertToolAllowed(role,server,name);}catch(error){await db.taskEvent.create({data:{taskId:this.taskId,type:"TOOL_DENIED",title:`${role} was denied ${server}.${name}`,tool:`${server}.${name}`,agentRole:role,status:"DENIED",iteration,input:sanitizeInput(args) as never}});throw error;}
    return this.execute(server,name,args,role,iteration);
  }

  async callTrusted(server:ServerName,name:string,args:Record<string,unknown>={}){return this.execute(server,name,args,undefined,0);}
  private async execute(server:ServerName,name:string,args:Record<string,unknown>,role?:ToolRole,iteration=0) {
    const client = this.clients.get(server);
    if (!client) throw new Error(`MCP server ${server} is not connected`);
    const started = Date.now();
    try {
      const result = await client.callTool({ name, arguments: args },undefined,{timeout:server==="runner"?11*60_000:60_000});
      const content = result.content as Array<{type:string;text?:string}>;
      const raw = content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n");
      if (result.isError) throw new Error(raw || `${name} failed`);
      await db.taskEvent.create({ data: { taskId:this.taskId,type:"TOOL_COMPLETED",title:`${role??"SYSTEM"} used ${server}.${name}`,tool:`${server}.${name}`,agentRole:role,status:"COMPLETED",durationMs:Date.now()-started,iteration,input:sanitizeInput(args) as never,output:{resultChars:raw.length,resultHash:createHash("sha256").update(raw).digest("hex").slice(0,16)} } });
      return raw;
    } catch (error) {
      await db.taskEvent.create({ data: { taskId:this.taskId,type:"TOOL_FAILED",title:`${role??"SYSTEM"} failed ${server}.${name}`,tool:`${server}.${name}`,agentRole:role,status:"FAILED",durationMs:Date.now()-started,iteration,input:args as never,output:{error:error instanceof Error?error.message:String(error)} } });
      throw error;
    }
  }

  async close() { await Promise.all([...this.clients.values()].map(client => client.close())); }
}

export function parseToolJson<T>(raw: string): T {
  try { return JSON.parse(raw) as T; } catch { return raw as T; }
}
