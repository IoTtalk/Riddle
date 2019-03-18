/**
 * Created by kuan on 2017/5/21.
 */
var express = require("express"),
    app = express(),
    http = require("http").createServer(app),
    io = require('socket.io')(http),
    fs = require('fs'),
    ejs = require('ejs'),
    shortid = require('shortid'),
    bodyParser = require('body-parser'),
    path = require('path'),
    formidable = require('formidable'),
    readChunk = require('read-chunk'),
    fileType = require('file-type'),
    dai = require("./dai").dai,
    config = require('./config'),
    websocketclient = require("./websocketclient").WebSocketClient,
    utils = require("./utils"),
    db = require('./db').db;

/*** upload ***/
let uploadFolder = './upload_cache/';
utils.createFolder(uploadFolder);
/******/

/*** register to IoTtalk ***/
// dai.register();

/*** connect websocket to paintingDA ***/
var connectedCount;
var isGamePlaying;
var playSock = undefined;

var ws2Painting = new websocketclient();
ws2Painting.open('ws://' + config.paintingIP + ':' + config.webSocketPort);
ws2Painting.onerror = function(err){
    console.log('FrameDA is not running!');
};
ws2Painting.onopen = function(){
    /*** socket.io ***/
    connectedCount = 0;
    isGamePlaying = false;
    var playID = undefined;
    io.on('connection', function(socket){
        connectedCount++; 
        console.log("connected count: " + connectedCount);
        socket.on("disconnect", function(){
            connectedCount--;
            console.log("connected count: " + connectedCount);
            if((isGamePlaying && playID == socket.id) || connectedCount == 0){
                ws2Painting.send(JSON.stringify({ "Command": "leaveGame" }));
                isGamePlaying = false;
                playID = undefined;
                playSock = undefined;
            }
        });
        //1
        console.log("1. ask player to send his url for checking");
        socket.emit("checkUrl", "");
        //2
        socket.on("checkUrl", function(msg){
            console.log("2. receive player's url", msg);
            if(msg != url){
                //3
                console.log("3. send checking result: false");
                socket.emit("checkUrlACK", {"urlCorrect": false});
            }
            else{
                ws2Painting.send(JSON.stringify({ "Command": "enterGame" }));
                //3
                console.log("3. send checking result: true");
                socket.emit("checkUrlACK", {"urlCorrect": true});
            }
        });
        //4
        socket.on("playACK", function(msg){
            console.log("4. receive player's play-game request");
            if(playID != socket.id){
                //5
                console.log("5. send Frame's status");
                socket.emit("isGamePlaying", {"isGamePlaying": isGamePlaying});
                if(isGamePlaying == false){
                    isGamePlaying = true;
                    playID = socket.id;
                    playSock = socket;
                    console.log("player socket id", playID);
                    console.log("5.5 Frame is player:", socket.id,"'s turn now");
                    socket.broadcast.emit('isGamePlaying', {"isGamePlaying": isGamePlaying});
                }
            }
        });
        //6
        socket.on("playGroup", function(msg){
            console.log("6. receive playing group info:", msg);
            ganerateGameInfo(msg.playType, msg.playingGroup, "play", socket);
            //7
            // socket.emit("GameStart", gameInfo);
        });
        //8
        socket.on("Name-I", function(msg){
            //sand answer picture path list to processing
            ws2Painting.send(JSON.stringify({
                "Command": "gameTarget",
                "path" : answer_pic_list
            }));
            // dai.push("Name_I", [msg]);
            console.log("8. receive game-ready signal, let processing to display answer picture");
        });
        //9
        socket.on("Correct", function(msg){
            ws2Painting.send(JSON.stringify({ "Command": "Correct" }));
            // dai.push("Correct", [1]);
            console.log("9. player makes the Correct choice, let processing play all remained pictures");
        });
        //9
        socket.on("Wrong", function(msg){
            ws2Painting.send(JSON.stringify({ "Command": "Wrong" }));
            // dai.push("Wrong", [1]);
            console.log("9. player makes the Wrong choice, let processing play the next picture");
        });
        //10
        socket.on("NewGameReq", function(msg){
            console.log("10. receive player's play-again request");
            ganerateGameInfo(msg.playType, msg.playingGroup, "play", socket);
            // dai.push("NextGame", [1]);
            // 11
            // socket.emit("NewGameRes", gameInfo);
        });
        //12
        socket.on("NewGroupReq", function(msg){
            console.log("12. receive player's play-other-group request");
            getGameGroup("socket", socket, null, null);
            // dai.push("NewGame", [1]);
            // 13
            // socket.emit("NewGroupRes", gameInfo);
        })
    });
};
ws2Painting.onmessage = function(data, flags, number){
    let signal_type = data.split(":")[0]
    let status = data.split(":")[1]
    console.log(data, signal_type, status);
    
    if(signal_type == "load" && playSock != undefined){
        playSock.emit("loading", status);
        if(status == "finish"){
            console.log("6.5. send loading finish signal to player", playSock.id, " to release loading page");
        }
    }
    if(signal_type == "display" && playSock != undefined){
        playSock.emit("displayFinish", true);
        console.log("9.5 got processing display done");
    }
};

var answer_pic_list = [],
    url = shortid.generate();
console.log("----Game url----\n", url);

//static files
app.use(express.static("../web"));

app.use(bodyParser.urlencoded({
    extended: true,
}));

// process http body
app.use(bodyParser.json());

// decompose html (let html can include html)
app.set("view engine", "html");
app.set("views", path.join(__dirname, "../web/html"));
app.engine("html", ejs.renderFile);

// server start
console.log('---server start---');
http.listen((process.env.PORT || config.webServerPort), '0.0.0.0');

//[TODO] use class(global) to store game info

function ganerateGameInfo(playtype, group_id, mode, socket){
    let answer_idx_in_list, 
        answer_idx = 0, 
        answer_name, 
        answer_questionid, 
        answer_description = "", 
        index;
    let game_list = [], 
        random_idx_list = [];
    let pic_dict = {}, 
        gameInfo = {};
    let GameQuestionData, 
        AnswerData, 
        AnswerPicData;

    console.log("---generating GameInfo for this game....---");
    if(playtype == "class"){
        db.Class.findAll({
            include: [{
                model: db.Question,
                where: {status: 1},
                reqired: true }]
        }).then(ClassList => {
            let random_class_idx = Math.floor(Math.random() * ClassList.length);
            let random_class_data = ClassList[random_class_idx].get({plain :true});
            let random_class_id = random_class_data.id;
            console.log("random_class_id:", random_class_id);

            db.Question.findAll({ where: {
                ClassId: random_class_id, 
                status: 1
            }}).then(GameQuestionList => {
                //check length of GameQuestionList to generate game_list and answer question
                if(GameQuestionList.length > 5){
                    //random pick 5 question for game
                    //[TODO] shuffle
                    do{
                        index = Math.floor(Math.random() * GameQuestionList.length);
                        //check if this random index has existed
                        if(random_idx_list.indexOf(index) <= -1){ 
                            random_idx_list.push(index);
                        }
                    } while(random_idx_list.length < 5);

                    for(let i = 0; i < 5; i++){
                        GameQuestionData = GameQuestionList[random_idx_list[i]].get({plain: true});
                        game_list.push(GameQuestionData.name);
                    }

                    //random generate answer_idx
                    answer_idx = Math.floor(Math.random() * 5);

                    //get answer_idx_in_list
                    answer_idx_in_list = random_idx_list[answer_idx];
                }
                else{ //pick all question for game
                    GameQuestionList.forEach((GameQuestionSetItem) => {
                        GameQuestionData = GameQuestionSetItem.get({plain: true});
                        game_list.push(GameQuestionData.name);
                    });

                    //random generate answer_idx
                    answer_idx = Math.floor(Math.random() * GameQuestionList.length);

                    //get answer_idx_in_list
                    answer_idx_in_list = answer_idx
                }
                console.log("game_list: ", game_list);
                console.log("answer:", game_list[answer_idx], " in option:", answer_idx);

                //get answer question for game
                AnswerData = GameQuestionList[answer_idx_in_list].get({plain: true});
                answer_description = AnswerData.description;
                console.log("answer_description:", answer_description);

                db.Picture.findAll({where: {QuestionId: AnswerData.id}}).then(AnswerPicList => {
                    //prepare pic_dict(key:order, value:filename)
                    AnswerPicList.forEach((AnswerPicSetItem => {
                        AnswerPicData = AnswerPicSetItem.get({plain: true});
                        pic_dict[AnswerPicData.order] = AnswerPicData.id;
                    }));

                    //according pic_order, generate answer_pic_list
                    answer_pic_list = [];
                    for(let i = 1; i <= AnswerPicList.length; i++){
                        answer_pic_list.push(pic_dict[i]);
                    }
                    console.log("answer_pic:", answer_pic_list);

                    //send game info
                    console.log("---GameInfo generation has been done--");
                    gameInfo["game_list"] = game_list;
                    gameInfo["answer_description"] = answer_description;
                    gameInfo["answer_idx"] = answer_idx;

                    if(mode == "play"){
                        //7
                        console.log("7. send gameInfo:", gameInfo);
                        socket.emit("GameStart", gameInfo);
                    }
                    else if(mode == "replay"){
                        //11
                        console.log("11. send next gameInfo", gameInfo);
                        socket.emit("NewGameRes", gameInfo);
                    }
                });
            });
        });
    }
    else{
        db.GroupMember.findAll({
            where: {GroupId: group_id},
            include: [{
                model: db.Question,
                where: {status: 1},
                required: true }]
        }).then(GameQuestionList => {
            //check length of GameQuestionList to generate game_list and answer question
            if(GameQuestionList.length > 5){
                //random pick 5 question for game
                //[TODO] shuffle
                do{
                    index = Math.floor(Math.random() * GameQuestionList.length);
                    //check if this random index has existed
                    if(random_idx_list.indexOf(index) <= -1){ 
                        random_idx_list.push(index);
                    }
                } while(random_idx_list.length < 5);

                for(let i = 0; i < 5; i++){
                    GameQuestionData = GameQuestionList[random_idx_list[i]].get({plain: true});
                    game_list.push(GameQuestionData.Question.name);
                }

                //random generate answer_idx
                answer_idx = Math.floor(Math.random() * 5);

                //get answer_idx_in_list
                answer_idx_in_list = random_idx_list[answer_idx];
            }
            else{ //pick all question for game
                GameQuestionList.forEach((GameQuestionSetItem) => {
                    GameQuestionData = GameQuestionSetItem.get({plain: true});
                    game_list.push(GameQuestionData.Question.name);
                });

                //random generate answer_idx
                answer_idx = Math.floor(Math.random() * GameQuestionList.length);

                //get answer_idx_in_list
                answer_idx_in_list = answer_idx
            }
            console.log("game_list: ", game_list);
            console.log("answer:", game_list[answer_idx], " in option:", answer_idx);

            //get answer question for game
            AnswerData = GameQuestionList[answer_idx_in_list].get({plain: true});
            answer_description = AnswerData.Question.description;
            console.log("answer_description:", answer_description);

            db.Picture.findAll({where: {QuestionId: AnswerData.Question.id}}).then(AnswerPicList => {
                //prepare pic_dict(key:order, value:filename)
                AnswerPicList.forEach((AnswerPicSetItem => {
                    AnswerPicData = AnswerPicSetItem.get({plain: true});
                    pic_dict[AnswerPicData.order] = AnswerPicData.id;
                }));

                //according pic_order, generate answer_pic_list
                answer_pic_list = [];
                for(let i = 1; i <= AnswerPicList.length; i++){
                    answer_pic_list.push(pic_dict[i]);
                }
                console.log("answer_pic:", answer_pic_list);

                //send game info
                console.log("---GameInfo generation has been done--");
                gameInfo["game_list"] = game_list;
                gameInfo["answer_description"] = answer_description;
                gameInfo["answer_idx"] = answer_idx;

                if(mode == "play"){
                    //7
                    console.log("7. send gameInfo:", gameInfo);
                    socket.emit("GameStart", gameInfo);
                }
                else if(mode == "replay"){
                    //11
                    console.log("11. send next gameInfo", gameInfo);
                    socket.emit("NewGameRes", gameInfo);
                }
            });
        });
    }
}

function getGameGroup(mode, socket, res, contents){
    let playGroup_list = [], playClassGroup_list = [];
    let GroupData, ClassData;
    console.log("receive Game request, generating playGroupList...");

    //get all ready groups
    db.Group.findAll({where: {status: 1}}).then(GroupList => {
        GroupList.forEach((GroupSetItem) => {
            GroupData = GroupSetItem.get({plain :true});
            playGroup_list.push({
                id: GroupData.id,
                class_id: GroupData.ClassId,
                name: GroupData.name,
            });
        });
        console.log(playGroup_list);
        
        if(mode == "web"){
            contents = contents.toString('utf8');
            utils.sendEjsRenderResponse(res, 200, contents, {
                groupList: playGroup_list,
                webSocketPort: config.webSocketPort, 
                webServerPort: config.webServerPort,
                paintingIP: config.paintingIP
            });
        }
        else if(mode == "socket"){
            // 13
            //add classList
            console.log("13. send playGroup_list response", playClassGroup_list, "\n", playGroup_list);
            socket.emit("NewGroupRes", {
                groupList: playGroup_list
            });
        }
    });
}

/* APIs */
// authentication url API
app.post("/url",function(req, res){
    if(req.body.accessToken == config.accessToken){
        url = shortid.generate();
        console.log(url);
        let fullUrl = req.protocol + '://' + req.get('host') + '/' + url;
        utils.sendResponse(res, 200, fullUrl);
    }
    else{
        utils.sendResponse(res, 403, "permission denied");
    }
});



// get getClass API
//mode: all, pending, approved
app.get("/getClass", function(req, res){
    console.log('---getClass---');
    let mode = req.query.mode,
        class_list = [];

    console.log("mode: ", mode);
    if(mode == "all"){
        db.Class.findAll({order: [ ['id', 'ASC'] ]}).then(ClassList => {
            let count = 0;

            ClassList.forEach((ClassSetItem) => {
                let ClassData = ClassSetItem.get({ plain: true });

                class_list.push({
                    id: ClassData.id,
                    name: ClassData.name,
                    sample_name: ClassData.sample_name,
                    description: ClassData.description
                });
                
                count += 1;
                if(count == ClassList.length){
                    console.log(class_list);

                    //send response
                    utils.sendResponse(res, 200, JSON.stringify(class_list));
                }
            });
        });
    }
    else if(mode == "pending"){
        db.Class.findAll({
            order: [ ['id', 'ASC'] ],
            include: [{
                model: db.Question,
                where: {status: 0},
                reqired: true }]
        }).then(ClassList => {
            ClassList.forEach((ClassData) => {
                class_list.push({
                    id: ClassData.id,
                    name: ClassData.name,
                });
            });
            console.log(class_list);
            //send response
            utils.sendResponse(res, 200, JSON.stringify(class_list));
        });
    }
    else if(mode == "approved"){
        db.Class.findAll({
            order: [ ['id', 'ASC'] ],
            include: [{
                model: db.Question,
                where: {status: 1},
                reqired: true }]
        }).then(ClassList => {
            ClassList.forEach((ClassData) => {
                class_list.push({
                    id: ClassData.id,
                    name: ClassData.name,
                });
            });
            console.log(class_list);
            //send response
            utils.sendResponse(res, 200, JSON.stringify(class_list));
        });
    }
});

// post addNewClass API
app.post("/addNewClass", function(req, res){
    let new_class_name = req.body.new_class_name,
        new_sample_name = req.body.new_sample_name,
        new_sample_description = req.body.new_sample_description;

    console.log("---addNewClass---");
    console.log("new class name: ", new_class_name, 
                "\nnew sample name: ", new_sample_name, 
                "\nnew sample description: ", new_sample_description);
    db.Class.create({
        name: new_class_name,
        sample_name: new_sample_name,
        description: new_sample_description
    }).then(function(){
        db.Class.findOne({ where: {name: new_class_name}}).then(function(c){
            if(c != null){
                console.log("new class id:", c.id);

                //send response
                utils.sendResponse(res, 200, JSON.stringify({class_id: c.id}));
            }
        });
    }).catch(function(err){ //duplicate category name
        //response
        console.log(err);
        utils.sendResponse(res, 400, JSON.stringify(err));
    });
});



// get getQuestion API
//mode: all, one; status: 0, 1
app.get("/getQuestion", function(req, res){
    console.log("---getQuestion---");
    let mode = req.query.mode,
        class_id = req.query.class_id;

    console.log("mode: ", mode);
    if(mode == "all"){
        if(class_id == "all"){
            let status = req.query.status,
                question_list = [];

            console.log("get question with class:", class_id, "and status:",status);
            db.Question.findAll({
                where: { status: status }
            }).then(QuestionList => {
                QuestionList.forEach((QuestionSetItem) => {
                    let QuestionData = QuestionSetItem.get({ plain: true });
                    
                    question_list.push({
                        id : QuestionData.id,
                        name : QuestionData.name,
                        description : QuestionData.description
                    });
                });
                console.log(question_list);
                
                //response
                utils.sendResponse(res, 200, JSON.stringify({
                    question_list: question_list
                }));
            });
        }
        else{
            let status = req.query.status,
                question_list = [];

            console.log("get question with class:", class_id, "and status:",status);
            db.Question.findAll({
                where: { status: status, ClassId: class_id}
            }).then(QuestionList => {
                QuestionList.forEach((QuestionSetItem) => {
                    let QuestionData = QuestionSetItem.get({ plain: true });
                    
                    question_list.push({
                        id : QuestionData.id,
                        name : QuestionData.name,
                        description : QuestionData.description
                    });
                });
                console.log(question_list);
                
                db.Class.findOne({where: {id: class_id}}).then(function(c){
                    //response
                    utils.sendResponse(res, 200, JSON.stringify({
                        class_item: {
                            id: c.id,
                            name: c.name,
                            sample_name: c.sample_name,
                            description: c.description
                        },
                        question_list: question_list
                    }));
                });
            });
        }
    }
    else if(mode == "one"){
        let question_id = req.query.question_id,
            img_size = 0.0,
            total_img_size = 0.0,
            allGroup_dict = {},
            questionData = {};

        console.log("get question:", question_id, "all data");
        //find all Group for check which this question has checked
        db.Group.findAll({
            where: { ClassId: class_id },
            include: [{ model: db.GroupMember }],
            reqired: true
        }).then(GroupList => {
            GroupList.forEach((GroupSetItem) => {
                let GroupData = GroupSetItem.get({ plain: true });
                if(GroupData.GroupMembers.length != 0){
                    allGroup_dict[GroupData.id.toString()] = GroupData.name;
                }
            });

            //create checked group list
            let checkedGroup_list = [];
            for(let groupId in allGroup_dict){
                if(allGroup_dict.hasOwnProperty(groupId)){
                    checkedGroup_list.push({
                        id: groupId,
                        name: allGroup_dict[groupId],
                        used: 0
                    });
                }
            }

            //find question by id
            db.Question.findOne({
                where: { id: question_id, ClassId: class_id },
                include: [ { model: db.Picture },
                           { model: db.GroupMember }]
            }).then(QuestionObject => {
                let QuestionData = QuestionObject.get({ plain: true });

                //sort picture by order
                let picId, sortedPic_list = [];
                for(let i = 0; i < QuestionData.Pictures.length; i++){
                    picId = utils.getPicIdbyOrder(QuestionData.Pictures, i + 1);
                    if(picId != "none"){
                        img_size = Math.round((utils.getFilesizeInBytes("../web/img/" + picId) / 1000000.0) * 100) / 100;
                        total_img_size += img_size;
                        sortedPic_list.push({
                            src : picId,
                            size : img_size
                        });
                        // console.log(utils.getFilesizeInBytes("../web/img/" + picId) / 1000000.0);
                    }
                }


                //mark those group for this question
                for(let i = 0; i < checkedGroup_list.length; i++){
                    for(let j = 0; j < QuestionData.GroupMembers.length; j++){
                        if(checkedGroup_list[i].id == QuestionData.GroupMembers[j].GroupId){
                            checkedGroup_list[i].used = 1;
                        }
                    }
                }

                //set question data
                questionData["name"] = QuestionData.name;
                questionData["description"] = QuestionData.description;
                questionData["picture"] = sortedPic_list;
                questionData["group"] = checkedGroup_list;
                questionData["total_img_size"] = Math.round(total_img_size * 100) / 100;;
                console.log(questionData);

                //response
                utils.sendResponse(res, 200, JSON.stringify(questionData));
            });
        });
    }
});

// post questionUpload API
app.post('/questionUpload', function (req, res) {
    console.log("---questionUpload---");
    let question_id = utils.uuid().substring(0,16),
        user_upload_data = {}, img_order = {},
        qname = "", description = "", save_path = "",
        pictures = [], groupmembers = [], selected_group = [], photo_path = [],
        photo_status = true, class_id,
        form = new formidable.IncomingForm();

    form.multiples = true;
    form.uploadDir = path.join(__dirname, 'upload_cache');

    form.on('field', function(name, field) {
        if(name == "user_upload_data"){
            user_upload_data = JSON.parse(field);
            class_id = user_upload_data["class_id"];
            qname = user_upload_data["name"];
            description = user_upload_data["description"];
            img_order = user_upload_data["img_order"];
            selected_group = user_upload_data["selected_group"];

            console.log(user_upload_data);
        }
    });

    form.on('file', function (name, file) {
        let buffer = null, type = null, order = 0,
            picture_id = utils.uuid().substring(0,16);

        buffer = readChunk.sync(file.path, 0, 262);
        type = fileType(buffer);
        photo_path.push(file.path);

        // Check the file type, must be either png, jpg or jpeg
        if(type !== null && (type.ext === 'png' || type.ext === 'jpg' || type.ext === 'jpeg')) {
            save_path = "../web/img/" + picture_id + "." + type.ext;
            fs.rename(file.path, save_path, function(err, result) {
                if(err) console.log('error', err);
            });

            //find corresponding index from img_order
            if(img_order.hasOwnProperty(file.name)){
                order = img_order[file.name];
            }

            //add to pictures list for db create
            pictures.push({
                id: picture_id + "." + type.ext,
                order: order,
                origin_name: file.name
            });

            console.log(file.name, picture_id, order);
        }
        else {
            console.log(file.name, " suck");

            //dirty file
            photo_status = false;
        }
    });

    form.on('error', function(err) {
        console.log('Error occurred during processing - ' + err);
    });

    form.on('end', function() {
        console.log('All the request fields have been processed.');
    });

    // Parse the incoming form fields.
    form.parse(req, function (err, fields, files) {
        if(photo_status){
            //create this question to related db
            console.log("start create this question...");
            for(let i = 0; i < selected_group.length; i++){
                groupmembers.push({
                    GroupId: selected_group[i].group_id
                });
            }

            let data = {
                id : question_id,
                name : qname,
                description : description,
                status : 0,
                ClassId: class_id,
                Pictures : pictures,
                GroupMembers : groupmembers
            };
            db.Question.create(data, {include: [db.Picture, db.GroupMember]}).then(function(){
                console.log(question_id, " created!!");
                //send success response
                utils.sendResponse(res, 200, JSON.stringify({photo_status: 1}));
            });
        }
        else{
            console.log("this question upload fail");
            //delete all files
            for(let path in photo_path){
                fs.unlink(path, (err) => {
                    if(err){
                        console.log(path, " cannot be delete Q");
                    }
                });
            }
            //send failed response
            utils.sendResponse(res, 200, JSON.stringify({photo_status: 0}));
        }
    });
});

// put questionUpdate API
app.put('/questionUpdate', function (req, res) {
    let user_update_data = req.body.user_update_data,
        question_id = user_update_data.id,
        class_id = user_update_data.class_id,
        new_name = user_update_data.name,
        new_description = user_update_data.description,
        new_img_order = user_update_data.img_order,
        new_selected_group = user_update_data.selected_group;

    console.log("---questionUpdate---");
    console.log(user_update_data);
    //update this question for related db
    db.Question.update( //update question status
        { status: 1, 
          name: new_name, 
          description: new_description },
        { where: { id: question_id }}
    ).then(function(){
        //update question group
        db.GroupMember.destroy({ //destroy old question group
            where: { QuestionId: question_id }, force:true 
        }).then(function(){ //create new question group
            let new_selected_group_list = [];
            new_selected_group.forEach((groupId)=>{
                new_selected_group_list.push({
                    GroupId: groupId, QuestionId: question_id
                });
            });

            db.GroupMember.bulkCreate(new_selected_group_list).then(function() {
                //update picture order
                db.Picture.destroy({ //destroy old picture 
                    where: {QuestionId: question_id }, force:true
                }).then(function(){ //create new picture 
                    let new_picture_list = [];
                    for(let key in new_img_order){
                        if(new_img_order.hasOwnProperty(key)){
                            new_picture_list.push({
                                id: key,
                                order: new_img_order[key],
                                origin_name: "",
                                QuestionId: question_id
                            });
                        }
                    }
                    // console.log(new_picture_list);
                    db.Picture.bulkCreate(new_picture_list).then(function(){
                        console.log("pic update done");
                        //send response
                        utils.sendResponse(res, 200, "success!");
                    });
                });
            });
        });
    });
});

// delete questionDelete API
app.delete('/questionDelete', function(req, res){
    let delete_question_id = req.body.delete_question_id,
        index, using_flag = false, approved_flag = false;

    /* delete this question from all related tables */
    console.log("---questionDelete---");
    console.log("checking:", delete_question_id, "...");
    //check this question is approved or not
    db.Question.findOne({ where: {id: delete_question_id}}).then(function(qq){
        if(qq != null){
            if(qq.status == 0){ //safe to be deleted
                console.log(delete_question_id, "is safe to be deleted");
                //unlink related picture files from server
                db.Picture.findAll({ where: {QuestionId: delete_question_id} }).then(PictureList => {
                    let pic_count = 0;

                    PictureList.forEach((PictureSetItem) => {
                        let PictureData = PictureSetItem.get({ plain: true });
                        let path = '../web/img/' + PictureData.id;

                        fs.unlink(path, (err) => {
                            if(err) console.log(PictureData.id, ' cannot be deleted');
                            else    console.log(PictureData.id, ' deleted');
                        });

                        pic_count += 1;
                        if(pic_count == PictureList.length){
                            //delete all picture files from server storage
                            console.log("all pictures have been successfully deleted from server storage");
                            db.Question.destroy({ where: { id: delete_question_id } }).then(function(){
                                console.log("delete ", delete_question_id, " success");

                                //send response
                                utils.sendResponse(res, 200, JSON.stringify({using: 0}));
                            });
                        }
                    });
                });
            }
            else{
                //check this question using or not
                db.Group.findAll({
                    where: {status: 1},
                    include: [{
                        model: db.GroupMember,
                        where: {QuestionId: delete_question_id},
                        reqired: true }]
                }).then(GroupList => {
                    if(GroupList.length > 0){ //this question is playing now, cannot be deleted
                        console.log(delete_question_id, "is using, cannot be deleted");
                        //send response "OPERATION DENIED"
                        utils.sendResponse(res, 200, JSON.stringify({using: 1}));
                    }
                    else{ //safe to be deleted
                        console.log(delete_question_id, "is safe to be deleted");
                        //unlink related picture files from server
                        db.Picture.findAll({ where: {QuestionId: delete_question_id} }).then(PictureList => {
                            let pic_count = 0;

                            PictureList.forEach((PictureSetItem) => {
                                let PictureData = PictureSetItem.get({ plain: true });
                                let path = '../web/img/' + PictureData.id;

                                fs.unlink(path, (err) => {
                                    if(err) console.log(PictureData.id, ' cannot be deleted');
                                    else    console.log(PictureData.id, ' deleted');
                                });

                                pic_count += 1;
                                if(pic_count == PictureList.length){
                                    //delete all picture files from server storage
                                    console.log("all pictures have been successfully deleted from server storage");
                                    db.Question.destroy({ where: { id: delete_question_id } }).then(function(){
                                        console.log("delete ", delete_question_id, " success");

                                        //send response
                                        utils.sendResponse(res, 200, JSON.stringify({using: 0}));
                                    });
                                }
                            });
                        });
                    }
                });
            }
        }
    });
});


// get getGroup API
//mode: all, approved
app.get('/getGroup', function(req, res){
    let mode = req.query.mode;

    console.log("---getGroup---");
    console.log("mode:", mode);
    if(mode == "all"){
        let class_id = req.query.class_id,
            group_list = [];

        console.log("get all groups belongs to class_id:", class_id);
        db.Group.findAll({
            where: { ClassId: class_id },
            order: [ ['id', 'ASC'] ],
            include: [{ model: db.GroupMember }],
            reqired: true
        }).then(GroupList => {
            GroupList.forEach((GroupSetItem) => {
                let GroupData = GroupSetItem.get({ plain: true });
                // console.log(GroupData);
                if(GroupData.GroupMembers.length == 0){
                    console.log("group:", GroupData.name, " has no groupmember, filter it");
                }
                else{
                    group_list.push({
                        id : GroupData.id,
                        name : GroupData.name,
                        class_id : GroupData.ClassId,
                        status : GroupData.status
                    });
                }
            });
            console.log(group_list);

            db.Class.findOne({where: {id: class_id}}).then(function(c){
                //response
                utils.sendResponse(res, 200, JSON.stringify({
                    class_item: {
                        id: c.id,
                        name: c.name,
                        sample_name: c.sample_name,
                        description: c.description
                    },
                    group_list: group_list
                }));
            });
        });
    }
    else if(mode == "approved"){
        let class_id = req.query.class_id,
            group_list = [],
            class_list = [];

        console.log("get approved(filter those only contain pending questions) group from class_id:", class_id);
        if(class_id == "all"){
            db.Class.findAll({
                include: [{
                    model: db.Question,
                    where: {status: 1},
                    required: true}]
            }).then(ClassList => {
                ClassList.forEach((ClassSetItem) => {
                    let ClassData = ClassSetItem.get({plain: true});
                    if(ClassData.Questions.length != 0){
                        class_list.push({
                            id: ClassData.id,
                            name: '全部' + ClassData.name
                        });
                    }
                });
                console.log(class_list);

                db.Group.findAll({
                    order: [ ['id', 'ASC'] ],
                    include: [{
                        model: db.GroupMember,
                        include: [{
                            model: db.Question,
                            where: {status: 1},
                            required: true }],
                        required: true }]
                }).then(GroupList => {
                    if(GroupList.length == 0){
                        //send response
                        utils.sendResponse(res, 200, JSON.stringify({
                            class_list: class_list,
                            group_list: group_list
                        }));
                    }
                    else{
                        GroupList.forEach((GroupSetItem) => {
                            let GroupData = GroupSetItem.get({ plain: true });
                            group_list.push({
                                id : GroupData.id,
                                name : GroupData.name,
                                class_id : GroupData.ClassId,
                                status : GroupData.status
                            });
                        });
                        console.log(group_list);

                        //response
                        utils.sendResponse(res, 200, JSON.stringify({
                            class_list: class_list,
                            group_list: group_list
                        }));
                    }
                });
            });
        }
        else{
            db.Group.findAll({
                where: {ClassId: class_id},
                order: [ ['id', 'ASC'] ],
                include: [{
                    model: db.GroupMember,
                    include: [{
                        model: db.Question,
                        where: {status: 1},
                        required: true }],
                    required: true }]
            }).then(GroupList => {
                if(GroupList.length == 0){
                    //send response
                    utils.sendResponse(res, 200, JSON.stringify({
                        group_list: group_list
                    }));
                }
                else{
                    GroupList.forEach((GroupSetItem) => {
                        let GroupData = GroupSetItem.get({ plain: true });
                        group_list.push({
                            id : GroupData.id,
                            name : GroupData.name,
                            class_id : GroupData.ClassId,
                            status : GroupData.status
                        });
                    });
                    console.log(group_list);

                    //response
                    utils.sendResponse(res, 200, JSON.stringify({
                        group_list: group_list
                    }));
                }
            });
        }
    }
});

// post addNewHumanGroup API
app.post('/addNewGroup', function(req, res){
    let group_name = req.body.newgroup_name,
        group_list = req.body.group_list,
        class_id = req.body.class_id;

    console.log("---addNewGroup---");
    console.log("add new group name:", group_name);
    console.log("add new group belongs to class_id:", class_id);
    console.log("add new group member:", group_list);

    let data = {
        name : group_name,
        status : 0,
        ClassId : class_id,
        GroupMembers : group_list
    };

    db.Group.create(data, {include: [db.GroupMember]}).then(function(){
        db.Group.findOne({where: {name: group_name}}).then(function(g){
            if(g != null){
                console.log("new group added success with group_id:", g.id);

                // response
                utils.sendResponse(res, 200, JSON.stringify({
                    id: g.id,
                    name: g.name
                }));
            }
        });
    });
});

// delete deleteGroup API
app.delete('/deleteGroup', function(req,res){
    let delete_group_id = req.body.delete_group_id;
    console.log("---deleteGroup---");
    
    db.Group.destroy({where: { id: delete_group_id }}).then(function(){
        console.log("group_id:", delete_group_id, "successfully deleted");

        //send response
        utils.sendResponse(res, 200, "success!");
    });
});

// put updateGroup API
app.put('/updateGroup', function(req, res){
    let update_group_id = req.body.update_group_id,
        group_list = req.body.group_list,
        class_id = req.body.class_id,
        index;

    console.log("---updateGroup---");
    console.log("group_id:", update_group_id, "updating...");
    //destroy old member
    db.GroupMember.destroy({ where: { GroupId: update_group_id } }).then(function(){ 
        let new_groupmember_list = [];

        group_list.forEach((element)=>{
            new_groupmember_list.push({
                QuestionId: element.question_id,
                GroupId: update_group_id
            });
        });

        //create new member
        db.GroupMember.bulkCreate(new_groupmember_list).then(function(){
            console.log("update finish, checking group using or not");

            //send response
            utils.sendResponse(res, 200, "success");
        });
    });
});

//put setDisplayGroup API
app.put('/setDisplayGroup', function(req, res){
    let selected_group_list = req.body.selected_group_list,
        playlist = [];

    console.log("---setDisplayGroup---");
    console.log("display group:", selected_group_list);
    db.Group.update( //let all group set to unuse
        { status: 0 },
        { where: {status: 1} }
    ).then(function(){
        if(selected_group_list.length == 0){
            //send response
            utils.sendResponse(res, 200, "success");
        }
        else{
            let count = 0;
            selected_group_list.forEach((selected_group) => { //set selected group to use
                db.Group.update(
                    { status: 1 },
                    { where: {id: selected_group.id} }
                ).then(function(){
                    count += 1;
                    if(count == selected_group_list.length){
                        //send response
                        utils.sendResponse(res, 200, "success");
                    }
                });
            });
        }
    });
});



// get getGroupMember API
//mode: all, approved
app.get("/getGroupMember", function(req, res){
    let mode = req.query.mode;

    console.log("---getGroupMember---");
    console.log("mode:", mode);
    if(mode == "all"){
        let target_group_id = req.query.group_id,
            groupMember_list = [];

        console.log("get all groupmember from group_id:", target_group_id);
        db.GroupMember.findAll({ 
            where: { GroupId: target_group_id },
            order: [ ['id', 'ASC'] ],
            include: [{
                model: db.Question,
                required: true }]
        }).then(GroupMemberList => {
            if(GroupMemberList.length == 0){
                console.log(groupMember_list);
                
                //send response
                utils.sendResponse(res, 200, JSON.stringify({groupMember_list: groupMember_list}));
            }
            else{
                GroupMemberList.forEach((GroupMemberSetItem) => {
                    let GroupMemberData = GroupMemberSetItem.get({ plain: true });
                    
                    groupMember_list.push({
                        question_id: GroupMemberData.Question.id,
                        name: GroupMemberData.Question.name,
                        description: GroupMemberData.Question.description,
                        status: GroupMemberData.Question.status
                    });
                });
                console.log(groupMember_list);
                
                //send response
                utils.sendResponse(res, 200, JSON.stringify({groupMember_list: groupMember_list}));
            }
        });
    }
    else if(mode == "approved"){
        let target_group_id = req.query.group_id,
            groupMember_list = [];

        console.log("get approved groupmember from group_id:", target_group_id);
        db.GroupMember.findAll({ 
            where: { GroupId: target_group_id },
            order: [ ['id', 'ASC'] ],
            include: [{
                model: db.Question,
                where: {status: 1},
                required: true }]
        }).then(GroupMemberList => {
            if(GroupMemberList.length == 0){
                console.log(groupMember_list);
                
                //send response
                utils.sendResponse(res, 200, JSON.stringify({groupMember_list: groupMember_list}));
            }
            else{
                GroupMemberList.forEach((GroupMemberSetItem) => {
                    let GroupMemberData = GroupMemberSetItem.get({ plain: true });

                    groupMember_list.push({
                        id: GroupMemberData.Question.id,
                        name: GroupMemberData.Question.name,
                        description: GroupMemberData.Question.description,
                        status: 1
                    });
                });
                console.log(groupMember_list);
                
                //send response
                utils.sendResponse(res, 200, JSON.stringify({groupMember_list: groupMember_list}));
            }
        });
    }
});


function send_page_response(res, pagename, class_item=null, isadmin=false){
    let class_list = [],
        pendingClass_list = [],
        approvedClass_list = [];

    //using template send class_list to front end for home page
    db.Class.findAll({ order: [ ['id', 'ASC'] ]}).then(ClassList => {
        let count = 0;
        ClassList.forEach((ClassSetItem) => { 
            let ClassData = ClassSetItem.get({ plain: true });
            //find pending class
            db.Question.findAll({ 
                where: {
                    status: 0, 
                    ClassId: ClassData.id}
            }).then(pendingQuestionList => {
                if(pendingQuestionList.length > 0){
                    pendingClass_list.push({
                        id: ClassData.id,
                        name: ClassData.name,
                        sample_name: ClassData.sample_name,
                        description: ClassData.description
                    });
                }
                //find approved class
                db.Question.findAll({
                    where: {
                        status: 1, 
                        ClassId: ClassData.id}
                }).then(approvedClassList => {
                    if(approvedClassList.length > 0){
                        approvedClass_list.push({
                            id: ClassData.id,
                            name: ClassData.name,
                            sample_name: ClassData.sample_name,
                            description: ClassData.description
                        });
                    }
                    //push class into class_list
                    class_list.push({
                        id: ClassData.id,
                        name: ClassData.name,
                        sample_name: ClassData.sample_name,
                        description: ClassData.description
                    });
                    count += 1;
                    if(count == ClassList.length){
                        let data = {
                            class_list: class_list,
                            pendingClass_list: pendingClass_list,
                            approvedClass_list: approvedClass_list,
                            class_item: class_item,
                            isadmin: isadmin
                        };
                        console.log(data);

                        //send response
                        res.status(200);
                        res.render(pagename, data);
                    }
                });
            });
        });
    });
}

function check_class_exist_and_then_render_page(class_id, res, functionpage, isadmin=false){
    db.Class.findOne({where:{id :class_id}}).then(function(c){
        if(c != null){
            let class_item = {
                id: c.id,
                name: c.name,
                sample_name: c.sample_name,
                description: c.description
            };
            send_page_response(res, functionpage, class_item, isadmin);
        }
        else{
            //no this class
            res.status(404).send("page not found");
        }
    });
}

/* web page */

// manage pages
app.get("/manage", utils.auth, function(req, res){
    send_page_response(res, "manage.html", null, true);
});

app.get("/manage/display", utils.auth, function(req, res){
    send_page_response(res, "display.html", null, true);
});

app.get("/manage/:functionpage/:class_id", utils.auth, function(req, res){
    let functionpage = req.params.functionpage,
        class_id = req.params.class_id;

    console.log("functionpage:", functionpage, " class_id:", class_id);
    check_class_exist_and_then_render_page(class_id, res, functionpage + ".html", true);
});

// user page
app.get("/user", function(req, res){
    send_page_response(res, "manage.html");
});
app.get("/user/upload/:class_id", function(req, res){
    let class_id = req.params.class_id;
    check_class_exist_and_then_render_page(class_id, res, "upload.html");
});

// other page
app.get("/*", function(req, res){
    if(req.originalUrl.substr(1) != url){
        fs.readFile("../web/html/endPage.html", function (err, contents) {
            if(err){ console.log(err); }
            else{
                contents = contents.toString('utf8');
                utils.sendResponse(res, 200, contents);
            }
        });
        return;
    }
    else{
        fs.readFile("../web/html/index.html", function(err, contents){
            if(err){ console.log(err); }
            else if(isGamePlaying){
                fs.readFile("../web/html/endPage.html", function(err, contents){
                    if(err){ console.log(err); }
                    else{
                        contents = contents.toString('utf8');
                        utils.sendResponse(res, 200, contents);
                    }
                });
            }
            else{
                getGameGroup("web", null, res, contents)
            }
        });
    }
});
