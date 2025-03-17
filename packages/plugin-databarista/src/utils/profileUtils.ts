/**
 * Utility functions for handling profile data
 */
import { IAgentRuntime, elizaLogger } from "@elizaos/core";
import { MongoClient } from 'mongodb';
import { DataBaristaLogger } from "./loggingUtils";
import { dataCache } from "./cacheUtils";
import { mongoDbManager } from "./mongoDbManager";

/**
 * Interface for profile data returned from MongoDB CKG
 * Simplified to use a single latestProfile field with text-based sections
 */
interface ProfileData {
  platform: string;
  username: string;
  latestProfile?: {
    private: string;
    public: string;
    ideal: string;
    timestamp?: Date;
    embedding?: number[];
    ideal_embedding?: number[];
  };
  timestamp?: Date;
  lastUpdated?: Date;
  matchHistory?: Array<{
    platform: string;
    username: string;
    timestamp: Date;
  }>;
  matchRequests?: Array<{
    timestamp: Date;
    count: number;
  }>;
  telegramChatId?: string;
  community?: string;
  agentUsername?: string;
  profileVersions?: Array<{
    private: string;
    public: string;
    ideal: string;
    timestamp: Date;
    embedding?: number[];
    ideal_embedding?: number[];
  }>;
}

// Database connection singleton
let ckgClient: MongoClient | null = null;

/**
 * Ensure connection to the MongoDB CKG database
 */
async function ensureCkgConnection(runtime: IAgentRuntime): Promise<MongoClient> {
  if (ckgClient) {
    return ckgClient;
  }

  try {
    const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
    const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');

    if (!connectionString) {
      throw new Error('MONGODB_CONNECTION_STRING_CKG not set in environment');
    }

    if (!dbName) {
      throw new Error('MONGODB_DATABASE_CKG not set in environment');
    }

    elizaLogger.info('Connecting to MongoDB CKG', { dbName });
    
    ckgClient = new MongoClient(connectionString);
    await ckgClient.connect();
    
    elizaLogger.info('Successfully connected to MongoDB CKG');
    
    return ckgClient;
  } catch (error) {
    elizaLogger.error('Failed to connect to MongoDB CKG', error);
    throw error;
  }
}

/**
 * Get a user profile directly from the database
 * @param runtime Agent runtime for database access
 * @param platform Social platform identifier
 * @param username Username on the platform
 * @returns User profile data or null if not found/error
 */
export async function getProfile(
  runtime: IAgentRuntime,
  platform: string,
  username: string
): Promise<any[]> {
  try {
    // Generate a cache key for this profile query
    const cacheKey = `profile:${platform}:${username}`;
    
    // Try to get from cache first
    return await dataCache.getOrCompute<any[]>(
      cacheKey,
      async () => {
        DataBaristaLogger.info(`Fetching user profile from MongoDB CKG for:\n    platform: "${platform}"\n    username: "${username}"`);
        
        const connectionString = runtime.getSetting('MONGODB_CONNECTION_STRING_CKG');
        const dbName = runtime.getSetting('MONGODB_DATABASE_CKG');
        
        if (!connectionString || !dbName) {
          DataBaristaLogger.error('Missing MongoDB connection settings');
          return [];
        }
        
        // Get MongoDB collection from the connection pool
        const startTime = Date.now();
        const collectionName = runtime.getSetting('MONGODB_DATABASE_COLLECTION') || platform;
        const collection = await mongoDbManager.getCollection(connectionString, dbName, collectionName);
        DataBaristaLogger.debug(`MongoDB collection obtained for profile retrieval in ${Date.now() - startTime}ms`);
        
        // Find all profiles for this username (old structure had multiple profiles)
        const profiles = await collection.find({ 
          platform, 
          username
        }).toArray();
        
        DataBaristaLogger.info(`Found ${profiles.length} profile(s) for ${username} on ${platform}`);
        return profiles;
      },
      // Cache profiles for 5 minutes
      5 * 60 * 1000
    );
  } catch (error) {
    DataBaristaLogger.error(`Error retrieving profiles: ${error}`);
    return [];
  }
}