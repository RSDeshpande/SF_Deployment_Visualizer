@RestResource(urlMapping='/dtrack/deployment/*')
global with sharing class DeploymentWebhookController {

    global class WebhookPayload {
        global String deployId;
        global String deployStatus;
        global String sourceBranch;
        global String targetBranch;
        global String commitSha;
        global String repoUrl;
        global Datetime deployedAt;
        global List<PRPayload> prs;
        global List<ArtifactPayload> artifacts;
        global List<String> authors;
    }

    global class PRPayload {
        global Integer number_x;
        global String title;
        global String url;
        global String author;
        global Datetime mergedAt;
        global String sourceBranch;
        global String targetBranch;
    }

    global class ArtifactPayload {
        global String name;
        global String type_x;
        global String filePath;
        global String author;
        global String changeType;
        global Integer prNumber;
    }

    global class WebhookResponse {
        global Boolean success;
        global String message;
        global String recordId;
    }

    @HttpPost
    global static void handlePost() {
        RestRequest req = RestContext.request;
        RestResponse res = RestContext.response;

        WebhookResponse responsePayload = new WebhookResponse();
        Savepoint sp = Database.setSavepoint();

        try {
            String requestBody = req.requestBody.toString();
            
            // Pre-process JSON to handle reserved keywords in Apex (number, type)
            requestBody = requestBody.replace('"number":', '"number_x":');
            requestBody = requestBody.replace('"type":', '"type_x":');

            WebhookPayload payload = (WebhookPayload) JSON.deserialize(requestBody, WebhookPayload.class);

            // 1. Upsert Deployment_Record__c
            Deployment_Record__c dep = new Deployment_Record__c();
            dep.Deploy_Id__c = payload.deployId;
            
            String status = payload.deployStatus;
            if (status == 'Succeeded') {
                status = 'Success';
            }
            dep.Status__c = status;
            
            dep.Source_Branch__c = payload.sourceBranch;
            dep.Target_Branch__c = payload.targetBranch;
            dep.Commit_SHA__c = payload.commitSha;
            dep.Repo_URL__c = payload.repoUrl;
            dep.Deployed_At__c = payload.deployedAt;

            Integer prCount = payload.prs != null ? payload.prs.size() : 0;
            Integer artifactCount = payload.artifacts != null ? payload.artifacts.size() : 0;
            Integer authorCount = payload.authors != null ? payload.authors.size() : 0;

            dep.Total_PRs__c = prCount;
            dep.Components_Deployed__c = artifactCount;
            dep.Total_Authors__c = authorCount;

            upsert dep Deploy_Id__c;

            // 2. Delete existing child PR and Artifact records for this deployment
            delete [SELECT Id FROM Deployment_PR__c WHERE Deployment_Record__c = :dep.Id];
            delete [SELECT Id FROM Deployment_Artifact__c WHERE Deployment_Record__c = :dep.Id];

            // 3. Insert all PR records linked to the deployment
            List<Deployment_PR__c> prsToInsert = new List<Deployment_PR__c>();
            if (payload.prs != null) {
                for (PRPayload prInfo : payload.prs) {
                    Deployment_PR__c pr = new Deployment_PR__c();
                    pr.Deployment_Record__c = dep.Id;
                    pr.PR_Number__c = prInfo.number_x;
                    pr.PR_Title__c = prInfo.title;
                    pr.PR_URL__c = prInfo.url;
                    pr.PR_Author__c = prInfo.author;
                    pr.Merged_At__c = prInfo.mergedAt;
                    pr.Source_Branch__c = prInfo.sourceBranch;
                    pr.Target_Branch__c = prInfo.targetBranch;
                    prsToInsert.add(pr);
                }
                insert prsToInsert;
            }

            // 4. Insert all Artifact records linked to the deployment
            List<Deployment_Artifact__c> artifactsToInsert = new List<Deployment_Artifact__c>();
            if (payload.artifacts != null) {
                for (ArtifactPayload artInfo : payload.artifacts) {
                    Deployment_Artifact__c art = new Deployment_Artifact__c();
                    art.Deployment_Record__c = dep.Id;
                    art.Artifact_Name__c = artInfo.name;
                    art.Artifact_Type__c = artInfo.type_x;
                    art.File_Path__c = artInfo.filePath;
                    art.Author__c = artInfo.author;
                    art.Change_Type__c = artInfo.changeType;
                    art.PR_Number__c = artInfo.prNumber;
                    artifactsToInsert.add(art);
                }
                insert artifactsToInsert;
            }

            responsePayload.success = true;
            responsePayload.message = 'Deployment details recorded successfully.';
            responsePayload.recordId = dep.Id;
            res.statusCode = 200;

        } catch (Exception e) {
            Database.rollback(sp);
            responsePayload.success = false;
            responsePayload.message = 'Error processing webhook: ' + e.getMessage() + '\n' + e.getStackTraceString();
            res.statusCode = 500;
        }

        res.addHeader('Content-Type', 'application/json');
        res.responseBody = Blob.valueOf(JSON.serialize(responsePayload));
    }
}
