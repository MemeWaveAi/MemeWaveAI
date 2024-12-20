# Bagel fine tuning

## Setup

Go to [bakery.bagel.net](https://bakery.bagel.net) and create an account. Then get an API key.

Set the `BAGEL_API_KEY` environment variable to your API key.

In bakery, create your model and fine-tune dataset.

## Fine-tune with Eliza

```bash
curl -X POST http://localhost:3000/fine-tune \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer jvBpxrTNqGqhnfQhSEqCdsG6aTSP8IBL" \
  -d '{
    "dataset_type": "MODEL",
    "title": "smollm2-fine-tuning-00000099",
    "category": "AI",
    "details": "Test",
    "tags": [],
    "user_id": "96c633e6-e973-446e-b782-6235324c0a56",
    "fine_tune_payload": {
      "asset_id": "d0a3f665-c207-4ee6-9daa-0cbdb272eeca",
      "model_name": "llama3-fine-tuning-00000001",
      "base_model": "0488b40b-829f-4c3a-9880-d55d76775dd1",
      "file_name": "qa_data.csv",
      "epochs": 1,
      "learning_rate": 0.01,
      "user_id": "96c633e6-e973-446e-b782-6235324c0a56",
      "use_ipfs": "false",
      "input_column": "question",
      "output_column": "answer"
    }
  }'
```

This can take a while to complete. You can check the status of the fine-tune job in the bakery dashboard. When it is complete, you can download the fine-tuned model here:

```bash
curl -X GET "http://localhost:3000/fine-tune/8566c47a-ada8-441c-95bc-7bb07656c4c1" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer jvBpxrTNqGqhnfQhSEqCdsG6aTSP8IBL".
```


## Verifiable Attestations
Configuration variables in .env

```shell
TEE_MODE="DOCKER"                    # LOCAL | DOCKER | PRODUCTION
WALLET_SECRET_SALT= "dfafdafda"            # ONLY define if you want to use TEE Plugin, otherwise it will throw errors
VLOG="true"
```

### verifiable agents
```shell
curl -X GET --location "http://localhost:3000/verifiable/agents"
```

### Query logs
```shell
curl -X POST --location "http://localhost:3000/verifiable/logs" \
    -H "Content-Type: application/json" \
    -d '{
          "query": {
            "contLike": "Twinkletwinkle"
          },
          "page": 1,
          "pageSize": 10
        }'
```

# Get attestation
```shell
curl -X POST --location "http://localhost:3000/verifiable/attestation" \
    -H "Content-Type: application/json" \
    -d '{
          "agentId": "9c321604-e69e-0e4c-ab84-bec6fd6baf92",
          "publicKey": "0x045b51a28c3b071104f3094b1934343eb831b8d56f16fc6e9a3304e9f051b24e584d806b20769b05eeade3a6c792db96f57b26cc38037907dd920e9be9f41f6184"
        }'

```
