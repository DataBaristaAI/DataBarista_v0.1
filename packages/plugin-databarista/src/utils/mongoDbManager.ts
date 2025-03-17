import { MongoClient, Collection, Db, Document } from "mongodb";
import { elizaLogger } from "@elizaos/core";

/**
 * MongoDB connection manager that implements connection pooling
 * to reuse connections across the application
 */
class MongoDbManager {
  private static instance: MongoDbManager;
  private clients: Map<string, MongoClient> = new Map();

  private constructor() {}

  /**
   * Get the singleton instance of the MongoDB manager
   */
  public static getInstance(): MongoDbManager {
    if (!MongoDbManager.instance) {
      MongoDbManager.instance = new MongoDbManager();
    }
    return MongoDbManager.instance;
  }

  /**
   * Get a MongoDB client for the given connection string
   * Creates a new client if one doesn't exist
   */
  private async getClient(connectionString: string): Promise<MongoClient> {
    if (!this.clients.has(connectionString)) {
      const client = new MongoClient(connectionString);
      await client.connect();
      this.clients.set(connectionString, client);
      elizaLogger.info(`Created new MongoDB connection for ${connectionString}`);
    }
    return this.clients.get(connectionString)!;
  }

  /**
   * Get a MongoDB collection from the connection pool
   */
  public async getCollection(
    connectionString: string,
    dbName: string,
    collectionName: string
  ): Promise<Collection<Document>> {
    const client = await this.getClient(connectionString);
    const db = client.db(dbName);
    return db.collection(collectionName);
  }

  /**
   * Get a MongoDB database from the connection pool
   */
  public async getDb(connectionString: string, dbName: string): Promise<Db> {
    const client = await this.getClient(connectionString);
    return client.db(dbName);
  }

  /**
   * Close all MongoDB connections
   * This should be called when shutting down the application
   */
  public async closeAll(): Promise<void> {
    for (const [connectionString, client] of this.clients.entries()) {
      try {
        await client.close();
        this.clients.delete(connectionString);
        elizaLogger.info(`Closed MongoDB connection for ${connectionString}`);
      } catch (error) {
        elizaLogger.error(`Error closing MongoDB connection for ${connectionString}: ${error}`);
      }
    }
  }
}

// Export the singleton instance
export const mongoDbManager = MongoDbManager.getInstance(); 