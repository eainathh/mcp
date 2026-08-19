*** Settings ***
Documentation     Testes de API gerados para GET /users/{id}
Library           RequestsLibrary
Library           Collections
Library           BuiltIn
Suite Setup       Configurar Sessao API
Suite Teardown    Encerrar Sessao API
Test Setup        Log    Iniciando cenario: ${TEST NAME}    console=True

*** Variables ***
${BASE_URL}       %{API_BASE_URL=http://localhost:8080}
${ENDPOINT_METHOD}    GET
${ENDPOINT_PATH}      /users/{id}

*** Keywords ***
Configurar Sessao API
    Create Session    api    ${BASE_URL}    verify=${FALSE}

Encerrar Sessao API
    Delete All Sessions

Criar Headers Autenticados
    [Arguments]    ${token}=Bearer <token-valido>
    &{headers}=    Create Dictionary    Authorization=${token}
    [Return]    &{headers}

Enviar Requisicao API
    [Arguments]    ${method}    ${path}    &{headers}=${EMPTY}    ${body}=${NONE}
    ${request_headers}=    Copy Dictionary    ${headers}
    Run Keyword If    '${body}' != '${NONE}'    Set To Dictionary    ${request_headers}    Content-Type=application/json
    ${has_body}=    Evaluate    '${body}' != '${NONE}'
    ${response}=    Run Keyword If    ${has_body}    ${method} On Session    api    ${path}    headers=${request_headers}    json=${body}
    ...    ELSE    Run Keyword    ${method} On Session    api    ${path}    headers=${request_headers}
    [Return]    ${response}

Validar Status HTTP
    [Arguments]    ${response}    @{expected_status}
    ${status}=    Convert To Integer    ${response.status_code}
    ${expected_list}=    Create List    @{expected_status}
    ${valid}=    Evaluate    $status in [int(code) for code in $expected_list]
    Should Be True    ${valid}    Status recebido ${status}, esperado @{expected_status}

Executar Cenario API
    [Arguments]    ${method}    ${path}    &{headers}=${EMPTY}    ${body}=${NONE}    @{expected_status}
    ${response}=    Enviar Requisicao API    ${method}    ${path}    &{headers}    ${body}
    Validar Status HTTP    ${response}    @{expected_status}
    [Return]    ${response}

*** Test Cases ***
GET /users/{id} - happy_path
    [Documentation]    Requisição com parâmetros válidos e autenticação quando exigida.
    ...    Given: {"endpoint":{"method":"GET","path":"/users/{id}"},"authentication":{"type":"bearer","token":"<token-valido>"},"parameters":{"id":1}}
    ...    When: GET /users/1
    ...    Then: A API deve processar a requisição com sucesso.
    [Tags]    happy_path    get    user    api    generated
    &{headers}=    Criar Headers Autenticados    token=Bearer <token-valido>
    ${body}=    Set Variable    ${NONE}
    Executar Cenario API    GET    /users/1    &{headers}    ${NONE}    200

GET /users/{id} - sad_path
    [Documentation]    Consulta ou manipula um recurso inexistente.
    ...    Given: {"endpoint":{"method":"GET","path":"/users/{id}"},"authentication":{"type":"bearer","token":"<token-valido>"},"parameters":{"id":"recurso-inexistente-999999"}}
    ...    When: GET /users/recurso-inexistente-999999
    ...    Then: A API deve informar que o recurso não foi encontrado.
    [Tags]    sad_path    get    user    api    generated
    &{headers}=    Criar Headers Autenticados    token=Bearer <token-valido>
    ${body}=    Set Variable    ${NONE}
    Executar Cenario API    GET    /users/recurso-inexistente-999999    &{headers}    ${NONE}    404

GET /users/{id} - invalid_data
    [Documentation]    Envia um parâmetro com tipo de dado incompatível.
    ...    Given: {"endpoint":{"method":"GET","path":"/users/{id}"},"authentication":{"type":"bearer","token":"<token-valido>"},"parameters":{"id":"tipo-invalido"}}
    ...    When: GET /users/tipo-invalido
    ...    Then: A API deve rejeitar a requisição por erro de validação.
    [Tags]    invalid_data    get    user    api    generated
    &{headers}=    Criar Headers Autenticados    token=Bearer <token-valido>
    ${body}=    Set Variable    ${NONE}
    Executar Cenario API    GET    /users/tipo-invalido    &{headers}    ${NONE}    400    422

GET /users/{id} - no_auth
    [Documentation]    Envia a requisição sem token ou credencial de autenticação.
    ...    Given: {"endpoint":{"method":"GET","path":"/users/{id}"},"authentication":null,"parameters":{"id":1}}
    ...    When: GET /users/1
    ...    Then: A API deve negar o acesso por falta de autenticação.
    [Tags]    no_auth    get    user    api    generated
    &{headers}=    Create Dictionary
    ${body}=    Set Variable    ${NONE}
    Executar Cenario API    GET    /users/1    &{headers}    ${NONE}    401    403
