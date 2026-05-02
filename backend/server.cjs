const express = require('express');
const { Sequelize, DataTypes, Op } = require('sequelize');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// ==================== CONFIGURATION ====================
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Create uploads directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Create public directory for default images
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}
// REPLACE the existing authenticateToken middleware with this:
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Access token required' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Get user from database using Sequelize
    const user = await User.findByPk(decoded.id, {
      attributes: ['id', 'email', 'firstName', 'lastName', 'role', 'schoolId']
    });
    
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    return res.status(403).json({ success: false, message: 'Invalid or expired token' });
  }
};

// Create a default logo placeholder
const defaultLogoSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">
  <rect width="100" height="100" fill="#4f46e5" rx="20"/>
  <text x="50" y="65" font-size="40" text-anchor="middle" fill="white" font-family="Arial">🏫</text>
</svg>`;
fs.writeFileSync(path.join(publicDir, 'default-logo.svg'), defaultLogoSVG);

// ==================== DATABASE CONNECTION ====================
const sequelize = new Sequelize(
  process.env.DB_NAME || 'schoolaid',
  process.env.DB_USER || 'postgres',
  process.env.DB_PASSWORD || 'postgres',
  {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    dialect: 'postgres',
    logging: console.log, // Enable logging to see queries
    dialectOptions: {
      ssl: process.env.DB_SSL === 'true' ? {
        require: true,
        rejectUnauthorized: false
      } : false
    }
  }
);

// ==================== GRADING SYSTEMS ====================

const GRADING_SYSTEMS = {
  // Kenya CBC (Competency Based Curriculum) - Primary & JSS
  CBC: {
    name: 'Kenya CBC',
    code: 'CBC',
    applicableTo: ['ECDE_PRIMARY_JSS'],
    levels: ['PP1', 'PP2', 'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7', 'Grade 8', 'Grade 9'],
    grading: {
      'EE': { min: 80, max: 100, grade: 'Exceeding Expectations', code: 'EE', points: 4, color: 'green' },
      'ME': { min: 65, max: 79, grade: 'Meeting Expectations', code: 'ME', points: 3, color: 'blue' },
      'AE': { min: 50, max: 64, grade: 'Approaching Expectations', code: 'AE', points: 2, color: 'yellow' },
      'BE': { min: 30, max: 49, grade: 'Below Expectations', code: 'BE', points: 1, color: 'orange' },
      'NI': { min: 0, max: 29, grade: 'Needs Improvement', code: 'NI', points: 0, color: 'red' }
    },
    hasPoints: false,
    hasGrades: true,
    hasComments: true,
    requiresDescriptions: true,
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.CBC.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, color: range.color };
        }
      }
      return { grade: 'Not Graded', code: 'NG', points: 0, color: 'gray' };
    }
  },

  // Kenya 8-4-4 System (Secondary)
  KENYA_844: {
    name: 'Kenya 8-4-4',
    code: '844',
    applicableTo: ['SENIOR_SECONDARY'],
    levels: ['Form 1', 'Form 2', 'Form 3', 'Form 4'],
    grading: {
      'A': { min: 80, max: 100, grade: 'A', points: 12, color: 'green' },
      'A-': { min: 75, max: 79, grade: 'A-', points: 11, color: 'green' },
      'B+': { min: 70, max: 74, grade: 'B+', points: 10, color: 'blue' },
      'B': { min: 65, max: 69, grade: 'B', points: 9, color: 'blue' },
      'B-': { min: 60, max: 64, grade: 'B-', points: 8, color: 'blue' },
      'C+': { min: 55, max: 59, grade: 'C+', points: 7, color: 'yellow' },
      'C': { min: 50, max: 54, grade: 'C', points: 6, color: 'yellow' },
      'C-': { min: 45, max: 49, grade: 'C-', points: 5, color: 'yellow' },
      'D+': { min: 40, max: 44, grade: 'D+', points: 4, color: 'orange' },
      'D': { min: 35, max: 39, grade: 'D', points: 3, color: 'orange' },
      'D-': { min: 30, max: 34, grade: 'D-', points: 2, color: 'orange' },
      'E': { min: 0, max: 29, grade: 'E', points: 1, color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    calculateMeanGrade: (points) => {
      if (points >= 80) return 'A';
      if (points >= 75) return 'A-';
      if (points >= 70) return 'B+';
      if (points >= 65) return 'B';
      if (points >= 60) return 'B-';
      if (points >= 55) return 'C+';
      if (points >= 50) return 'C';
      if (points >= 45) return 'C-';
      if (points >= 40) return 'D+';
      if (points >= 35) return 'D';
      if (points >= 30) return 'D-';
      return 'E';
    },
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.KENYA_844.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, color: range.color };
        }
      }
      return { grade: 'E', code: 'E', points: 1, color: 'red' };
    }
  },

  // International Baccalaureate (IB)
  IB: {
    name: 'International Baccalaureate',
    code: 'IB',
    applicableTo: ['INTERNATIONAL'],
    levels: ['IB Diploma', 'IB Certificate'],
    grading: {
      '7': { min: 85, max: 100, grade: '7', points: 7, description: 'Excellent', color: 'green' },
      '6': { min: 75, max: 84, grade: '6', points: 6, description: 'Very Good', color: 'blue' },
      '5': { min: 65, max: 74, grade: '5', points: 5, description: 'Good', color: 'blue' },
      '4': { min: 55, max: 64, grade: '4', points: 4, description: 'Satisfactory', color: 'yellow' },
      '3': { min: 45, max: 54, grade: '3', points: 3, description: 'Mediocre', color: 'orange' },
      '2': { min: 35, max: 44, grade: '2', points: 2, description: 'Poor', color: 'orange' },
      '1': { min: 0, max: 34, grade: '1', points: 1, description: 'Very Poor', color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.IB.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, color: range.color };
        }
      }
      return { grade: '1', code: '1', points: 1, color: 'red' };
    }
  },

  // Cambridge IGCSE
  CAMBRIDGE_IGCSE: {
    name: 'Cambridge IGCSE',
    code: 'IGCSE',
    applicableTo: ['INTERNATIONAL'],
    levels: ['IGCSE'],
    grading: {
      'A*': { min: 90, max: 100, grade: 'A*', points: 8, color: 'green' },
      'A': { min: 80, max: 89, grade: 'A', points: 7, color: 'green' },
      'B': { min: 70, max: 79, grade: 'B', points: 6, color: 'blue' },
      'C': { min: 60, max: 69, grade: 'C', points: 5, color: 'blue' },
      'D': { min: 50, max: 59, grade: 'D', points: 4, color: 'yellow' },
      'E': { min: 40, max: 49, grade: 'E', points: 3, color: 'orange' },
      'F': { min: 30, max: 39, grade: 'F', points: 2, color: 'orange' },
      'G': { min: 20, max: 29, grade: 'G', points: 1, color: 'red' },
      'U': { min: 0, max: 19, grade: 'U', points: 0, color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.CAMBRIDGE_IGCSE.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, color: range.color };
        }
      }
      return { grade: 'U', code: 'U', points: 0, color: 'red' };
    }
  },

  // TVET - Competency Based (Modules)
  TVET: {
    name: 'TVET Competency Based',
    code: 'TVET',
    applicableTo: ['COLLEGE_TVET'],
    levels: ['Certificate', 'Diploma', 'Higher Diploma'],
    grading: {
      'C': { min: 80, max: 100, grade: 'Competent', code: 'C', points: 4, color: 'green' },
      'NYC': { min: 0, max: 79, grade: 'Not Yet Competent', code: 'NYC', points: 0, color: 'red' }
    },
    hasPoints: false,
    hasGrades: true,
    isCompetencyBased: true,
    getGrade: (marks) => {
      if (marks >= 80) return { grade: 'Competent', code: 'C', points: 4, color: 'green' };
      return { grade: 'Not Yet Competent', code: 'NYC', points: 0, color: 'red' };
    }
  },

  // University - GPA Based
  UNIVERSITY: {
    name: 'University GPA System',
    code: 'UNI',
    applicableTo: ['UNIVERSITY'],
    levels: ['Year 1', 'Year 2', 'Year 3', 'Year 4', 'Year 5', 'Year 6'],
    grading: {
      'A': { min: 70, max: 100, grade: 'A', points: 5.0, gpa: 4.0, color: 'green' },
      'B+': { min: 65, max: 69, grade: 'B+', points: 4.5, gpa: 3.5, color: 'blue' },
      'B': { min: 60, max: 64, grade: 'B', points: 4.0, gpa: 3.0, color: 'blue' },
      'B-': { min: 55, max: 59, grade: 'B-', points: 3.5, gpa: 2.7, color: 'blue' },
      'C+': { min: 50, max: 54, grade: 'C+', points: 3.0, gpa: 2.3, color: 'yellow' },
      'C': { min: 45, max: 49, grade: 'C', points: 2.5, gpa: 2.0, color: 'yellow' },
      'C-': { min: 40, max: 44, grade: 'C-', points: 2.0, gpa: 1.7, color: 'yellow' },
      'D+': { min: 35, max: 39, grade: 'D+', points: 1.5, gpa: 1.3, color: 'orange' },
      'D': { min: 30, max: 34, grade: 'D', points: 1.0, gpa: 1.0, color: 'orange' },
      'E': { min: 0, max: 29, grade: 'E', points: 0.0, gpa: 0.0, color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    isGPABased: true,
    calculateGPA: (results) => {
      if (!results || results.length === 0) return 0;
      const totalPoints = results.reduce((sum, r) => sum + (r.points || 0), 0);
      const totalCredits = results.reduce((sum, r) => sum + (r.credits || 3), 0);
      return totalCredits > 0 ? (totalPoints / results.length).toFixed(2) : 0;
    },
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.UNIVERSITY.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, gpa: range.gpa, color: range.color };
        }
      }
      return { grade: 'E', code: 'E', points: 0.0, gpa: 0.0, color: 'red' };
    }
  },

  // American System (A-F with + and -)
  AMERICAN: {
    name: 'American',
    code: 'USA',
    applicableTo: ['INTERNATIONAL'],
    levels: ['Grade 9', 'Grade 10', 'Grade 11', 'Grade 12'],
    grading: {
      'A+': { min: 97, max: 100, grade: 'A+', points: 4.0, gpa: 4.0, color: 'green' },
      'A': { min: 93, max: 96, grade: 'A', points: 4.0, gpa: 4.0, color: 'green' },
      'A-': { min: 90, max: 92, grade: 'A-', points: 3.7, gpa: 3.7, color: 'green' },
      'B+': { min: 87, max: 89, grade: 'B+', points: 3.3, gpa: 3.3, color: 'blue' },
      'B': { min: 83, max: 86, grade: 'B', points: 3.0, gpa: 3.0, color: 'blue' },
      'B-': { min: 80, max: 82, grade: 'B-', points: 2.7, gpa: 2.7, color: 'blue' },
      'C+': { min: 77, max: 79, grade: 'C+', points: 2.3, gpa: 2.3, color: 'yellow' },
      'C': { min: 73, max: 76, grade: 'C', points: 2.0, gpa: 2.0, color: 'yellow' },
      'C-': { min: 70, max: 72, grade: 'C-', points: 1.7, gpa: 1.7, color: 'yellow' },
      'D+': { min: 67, max: 69, grade: 'D+', points: 1.3, gpa: 1.3, color: 'orange' },
      'D': { min: 63, max: 66, grade: 'D', points: 1.0, gpa: 1.0, color: 'orange' },
      'D-': { min: 60, max: 62, grade: 'D-', points: 0.7, gpa: 0.7, color: 'orange' },
      'F': { min: 0, max: 59, grade: 'F', points: 0.0, gpa: 0.0, color: 'red' }
    },
    hasPoints: true,
    hasGrades: true,
    hasGPA: true,
    getGrade: (marks) => {
      for (const [code, range] of Object.entries(GRADING_SYSTEMS.AMERICAN.grading)) {
        if (marks >= range.min && marks <= range.max) {
          return { grade: range.grade, code: range.code, points: range.points, gpa: range.gpa, color: range.color };
        }
      }
      return { grade: 'F', code: 'F', points: 0.0, gpa: 0.0, color: 'red' };
    }
  }
};

// ==================== MODEL DEFINITIONS ====================
const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  password: { type: DataTypes.STRING, allowNull: false },
  firstName: DataTypes.STRING,
  lastName: DataTypes.STRING,
  phone: DataTypes.STRING,
  role: {
    type: DataTypes.ENUM(
      // Super Admin
      'SUPER_ADMIN',
      
      // School Leadership
      'SCHOOL_ADMIN',
      'PRINCIPAL',
      'DEPUTY_PRINCIPAL',
      
      // Secondary/Primary Teaching
      'SENIOR_TEACHER',
      'CLASS_TEACHER',
      'SUBJECT_TEACHER',
      'TEACHER',
      
      // University Teaching
      'LECTURER',
      'SENIOR_LECTURER',
      'PROFESSOR',
      'DEAN',
      'HOD',
      
      // TVET Teaching
      'INSTRUCTOR',
      'TRAINER',
      'WORKSHOP_SUPERVISOR',
      
      // Support Staff
      'ACCOUNTANT',
      'LIBRARIAN',
      'NURSE',
      'MATRON',
      'TRANSPORT_MANAGER',
      
      // Human Resources
      'HR_MANAGER',
      'HR',
      
      // Parents & Students
      'PARENT',
      'STUDENT'
    ),
    defaultValue: 'TEACHER'
  },
  schoolId: { type: DataTypes.UUID, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  lastLogin: DataTypes.DATE,
  resetToken: { type: DataTypes.STRING, allowNull: true }
});

const School = sequelize.define('School', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: { type: DataTypes.STRING, unique: true },
  category: {
    type: DataTypes.ENUM(
      'ECDE_PRIMARY_JSS',
      'SENIOR_SECONDARY',
      'COLLEGE_TVET',
      'UNIVERSITY'
    ),
    allowNull: false
  },
  gradingSystem: {
    type: DataTypes.ENUM('CBC', '844', 'TVET', 'UNIVERSITY', 'IB', 'IGCSE', 'USA'),
    allowNull: false,
    defaultValue: 'CBC'
  },
  subscription: {
    type: DataTypes.JSONB,
    defaultValue: {
      plan: 'BASIC',
      status: 'ACTIVE'
    }
  },
  settings: {
    type: DataTypes.JSONB,
    defaultValue: {
      academicYear: new Date().getFullYear().toString(),
      terms: ['Term 1', 'Term 2', 'Term 3'],
      gradingSystem: {}
    }
  },
  contact: {
    type: DataTypes.JSONB,
    defaultValue: {
      email: '',
      phone: '',
      address: '',
      logo: '',
      county: '',
      constituency: '',
      ward: ''
    }
  },
  motto: DataTypes.STRING,
  established: DataTypes.STRING,
  registrationNumber: DataTypes.STRING,
  smsConfig: {
    type: DataTypes.JSONB,
    defaultValue: {
      provider: '',
      apiKey: '',
      senderId: '',
      enabled: false
    }
  },
  emailConfig: {
    type: DataTypes.JSONB,
    defaultValue: {
      host: '',
      port: '',
      username: '',
      password: '',
      fromEmail: '',
      enabled: false
    }
  },
  createdBy: DataTypes.UUID,
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Class = sequelize.define('Class', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  academicYear: DataTypes.STRING,
  capacity: DataTypes.INTEGER,
  streams: { type: DataTypes.JSONB, defaultValue: [] },
  classTeacherId: DataTypes.UUID,
  subjects: { type: DataTypes.JSONB, defaultValue: [] },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

// In your backend server.cjs, update the Student model
const Student = sequelize.define('Student', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  admissionNumber: { type: DataTypes.STRING, allowNull: false, unique: true },
  idType: { 
    type: DataTypes.ENUM('NATIONAL_ID', 'BIRTH_CERTIFICATE', 'PASSPORT', 'SCHOOL_ID', 'OTHER'),
    allowNull: true 
  },
  idNumber: { type: DataTypes.STRING, allowNull: true },
  firstName: { type: DataTypes.STRING, allowNull: false },
  lastName: { type: DataTypes.STRING, allowNull: false },
  middleName: DataTypes.STRING,
  
  // CONTACT FIELDS - ALL OPTIONAL (allowNull: true)
  email: { 
    type: DataTypes.STRING, 
    allowNull: true,  // ← NOT required
    validate: {
      isEmail: {
        msg: 'Must be a valid email address',
        args: true,
        // This validation only runs if email is provided
      }
    }
  },
  phone: { 
    type: DataTypes.STRING, 
    allowNull: true,  // ← NOT required
    validate: {
      is: {
        args: /^[0-9+\-\s()]{0,20}$/i,  // Optional phone validation
        msg: 'Please enter a valid phone number'
      }
    }
  },
  address: { 
    type: DataTypes.TEXT, 
    allowNull: true   // ← NOT required
  },
  
  dateOfBirth: DataTypes.DATEONLY,
  gender: DataTypes.ENUM('MALE', 'FEMALE', 'OTHER'),
  nationality: DataTypes.STRING,
  religion: DataTypes.STRING,
  birthCertificate: DataTypes.STRING,
  passportPhoto: DataTypes.STRING,
  classId: DataTypes.UUID,
  schoolId: { type: DataTypes.UUID, allowNull: false },
  enrollmentDate: DataTypes.DATEONLY,
  boardingStatus: DataTypes.ENUM('DAY', 'BOARDING', 'WEEKLY'),
  transportRouteId: { type: DataTypes.UUID, allowNull: true },
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  currentYear: { type: DataTypes.INTEGER, allowNull: true },
  currentSemester: { type: DataTypes.INTEGER, allowNull: true },
  currentModule: { type: DataTypes.STRING, allowNull: true },
  admissionDate: DataTypes.DATEONLY,
  expectedGraduation: DataTypes.DATEONLY,
  supervisor: DataTypes.STRING,
  thesisTitle: DataTypes.TEXT,
  medicalInfo: {
    type: DataTypes.JSONB,
    defaultValue: {
      bloodGroup: '',
      allergies: '',
      chronicConditions: '',
      disabilities: '',
      doctorName: '',
      doctorPhone: '',
      emergencyNotes: ''
    }
  },
  parentId: DataTypes.UUID,
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true },
  userId: { 
    type: DataTypes.UUID, 
    allowNull: true,
    references: {
      model: 'Users',
      key: 'id'
    }
  }
});

const Parent = sequelize.define('Parent', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: DataTypes.UUID,
  studentId: DataTypes.UUID,
  relationship: DataTypes.STRING,
  isPrimary: { type: DataTypes.BOOLEAN, defaultValue: false },
  emergencyContact: { type: DataTypes.BOOLEAN, defaultValue: false },
  occupation: DataTypes.STRING,
  employer: DataTypes.STRING,
  monthlyIncome: DataTypes.DECIMAL(10, 2),
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Subject = sequelize.define('Subject', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false },
  classId: DataTypes.UUID,
  teacherId: DataTypes.UUID,
  isCompulsory: { type: DataTypes.BOOLEAN, defaultValue: true },
  category: DataTypes.STRING,
  maxMarks: { type: DataTypes.INTEGER, defaultValue: 100 },
  passMarks: { type: DataTypes.INTEGER, defaultValue: 50 }
});

// Update your Exam model definition in the backend
const Exam = sequelize.define('Exam', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  type: {
    type: DataTypes.ENUM(
      'OPENER', 'MIDTERM', 'ENDTERM', 'CAT', 'MOCK', 'PRE_MOCK',
      'PRACTICAL', 'PROJECT', 'MAIN_EXAM', 'SUPPLEMENTARY', 'SPECIAL',
      'QUIZ', 'ASSIGNMENT', 'FINAL', 'LAB', 'PRESENTATION', 'THESIS', 'DEFENSE'
    )
  },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  classId: { type: DataTypes.UUID, allowNull: true },
  subjectId: { type: DataTypes.UUID, allowNull: true },
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  facultyId: { type: DataTypes.UUID, allowNull: true },
  departmentId: { type: DataTypes.UUID, allowNull: true },
  unitId: { type: DataTypes.UUID, allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  module: { type: DataTypes.INTEGER, allowNull: true },
  term: DataTypes.STRING,
  academicYear: DataTypes.STRING,
  date: DataTypes.DATEONLY,
  startTime: DataTypes.TIME,
  endTime: DataTypes.TIME,
  maxMarks: DataTypes.INTEGER,
  weightage: DataTypes.FLOAT,
  isPublished: { type: DataTypes.BOOLEAN, defaultValue: false },
  examHall: { type: DataTypes.STRING, allowNull: true },
  invigilator: { type: DataTypes.STRING, allowNull: true },
  invigilatorId: { type: DataTypes.UUID, allowNull: true } // ADD THIS FIELD
});
const Result = sequelize.define('Result', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  examId: { type: DataTypes.UUID, allowNull: false },
  subjectId: { type: DataTypes.UUID, allowNull: true },
  unitId: { type: DataTypes.UUID, allowNull: true },
  marks: DataTypes.FLOAT,
  grade: DataTypes.STRING,
  gradeCode: DataTypes.STRING,
  points: DataTypes.FLOAT,
  remarks: DataTypes.TEXT,
  description: DataTypes.TEXT,
  position: DataTypes.INTEGER,
  isAbsent: { type: DataTypes.BOOLEAN, defaultValue: false },
  gradingSystem: { type: DataTypes.STRING, allowNull: true }
});

// In your server.cjs, find the Attendance model definition and update it
const Attendance = sequelize.define('Attendance', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  classId: { type: DataTypes.UUID, allowNull: true }, 
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  unitId: { type: DataTypes.UUID, allowNull: true },
  subjectId: { type: DataTypes.UUID, allowNull: true },
  timetableId: { type: DataTypes.UUID, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false }, // ADD THIS LINE
  period: { type: DataTypes.INTEGER, allowNull: true },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  status: {
    type: DataTypes.ENUM('PRESENT', 'ABSENT', 'LATE', 'PERMISSION', 'SICK', 'FIELD_TRIP')
  },
  timeIn: DataTypes.TIME,
  timeOut: DataTypes.TIME,
  startTime: DataTypes.TIME,
  endTime: DataTypes.TIME,
  remarks: DataTypes.TEXT,
  markedBy: DataTypes.UUID,
  year: { type: DataTypes.INTEGER, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  module: { type: DataTypes.STRING, allowNull: true }
});
const Fee = sequelize.define('Fee', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  classId: { type: DataTypes.UUID, allowNull: true },
  courseId: { type: DataTypes.UUID, allowNull: true },
  facultyId: { type: DataTypes.UUID, allowNull: true },
  departmentId: { type: DataTypes.UUID, allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  moduleId: { type: DataTypes.UUID, allowNull: true },
  level: { type: DataTypes.STRING, allowNull: true },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  term: DataTypes.STRING,
  academicYear: DataTypes.STRING,
  dueDate: DataTypes.DATEONLY,
  category: DataTypes.STRING,
  isOptional: { type: DataTypes.BOOLEAN, defaultValue: false },
  isRecurring: { type: DataTypes.BOOLEAN, defaultValue: false },
  allocationType: { type: DataTypes.ENUM('AUTO', 'MANUAL'), defaultValue: 'AUTO' },
  appliesTo: { type: DataTypes.JSONB, defaultValue: ['ALL'] },
  transportRouteId: { type: DataTypes.UUID, allowNull: true }
});

const Payment = sequelize.define('Payment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { 
    type: DataTypes.UUID, 
    allowNull: true 
  },
  feeId: { type: DataTypes.UUID, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  paymentMethod: {
    type: DataTypes.ENUM('CASH', 'MPESA', 'BANK', 'CHEQUE', 'CARD')
  },
  transactionId: DataTypes.STRING,
  reference: DataTypes.STRING,
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  receiptNo: { type: DataTypes.STRING, unique: true },
  notes: DataTypes.TEXT,
  recordedBy: DataTypes.UUID,
  mpesaCode: { type: DataTypes.STRING, allowNull: true },
  mpesaPhone: { type: DataTypes.STRING, allowNull: true },
  bankReference: { type: DataTypes.STRING, allowNull: true },
  bankMessage: { type: DataTypes.STRING, allowNull: true },
  cardLast4: { type: DataTypes.STRING(4), allowNull: true },
  cardApprovalCode: { type: DataTypes.STRING, allowNull: true },
  chequeNumber: { type: DataTypes.STRING, allowNull: true },
  chequeBank: { type: DataTypes.STRING, allowNull: true },
  paymentDate: { type: DataTypes.DATEONLY, allowNull: true },
  isOtherIncome: { type: DataTypes.BOOLEAN, defaultValue: false },
  incomeCategory: { type: DataTypes.STRING, allowNull: true },
  description: { type: DataTypes.STRING, allowNull: true },
  payer: { type: DataTypes.STRING, allowNull: true },
  studentName: { type: DataTypes.STRING, allowNull: true },
  admissionNumber: { type: DataTypes.STRING, allowNull: true },
  courseName: { type: DataTypes.STRING, allowNull: true },
  className: { type: DataTypes.STRING, allowNull: true },
  feeName: { type: DataTypes.STRING, allowNull: true }
});

const CourseUnit = sequelize.define('CourseUnit', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: { type: DataTypes.STRING, allowNull: true },
  courseId: { type: DataTypes.UUID, allowNull: true }, // Changed to allow null
  programId: { type: DataTypes.UUID, allowNull: true }, // Added for TVET
  semester: { type: DataTypes.INTEGER, allowNull: true },
  module: { type: DataTypes.INTEGER, allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
  credits: { type: DataTypes.INTEGER, allowNull: true, defaultValue: 3 },
  description: { type: DataTypes.TEXT, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Expense = sequelize.define('Expense', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  category: DataTypes.STRING,
  description: DataTypes.TEXT,
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  paymentMethod: DataTypes.STRING,
  receiptNo: DataTypes.STRING,
  vendor: DataTypes.STRING,
  approvedBy: DataTypes.UUID,
  notes: DataTypes.TEXT
});
const Staff = sequelize.define('Staff', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  userId: { type: DataTypes.UUID, allowNull: false },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  employeeId: DataTypes.STRING,
  tscNumber: DataTypes.STRING,
  
  // Department/Faculty - can be UUID reference or string
  departmentId: { type: DataTypes.UUID, allowNull: true }, // Link to Departments table
  facultyId: { type: DataTypes.UUID, allowNull: true },    // Link to Faculties table
  department: DataTypes.STRING, // Keep as fallback
  
  // Academic/Professional Titles
  academicTitle: {
    type: DataTypes.ENUM(
      'Professor', 
      'Associate Professor', 
      'Senior Lecturer', 
      'Lecturer', 
      'Assistant Lecturer',
      'Tutorial Fellow',
      'Instructor',
      'Senior Instructor',
      'Master Trainer',
      'Trainer',
      'Workshop Supervisor'
    ),
    allowNull: true
  },
  
  jobTitle: DataTypes.STRING, // Keep for backward compatibility
  
  // Administrative Positions
  administrativeRole: {
    type: DataTypes.ENUM(
      'Dean',
      'Associate Dean',
      'Head of Department',
      'Assistant HOD',
      'Programme Leader',
      'Course Coordinator',
      'Workshop Manager',
      'Lab Manager',
      'None'
    ),
    defaultValue: 'None'
  },
  
  // For HOD/Dean - which department/faculty they manage
  managesDepartmentId: { type: DataTypes.UUID, allowNull: true },
  managesFacultyId: { type: DataTypes.UUID, allowNull: true },
  
  employmentDate: DataTypes.DATEONLY,
  
  // Qualifications
  qualifications: { 
    type: DataTypes.JSONB, 
    defaultValue: [] 
  },
  
  // For TVET - trade specializations
  tradeSpecialization: {
    type: DataTypes.STRING,
    allowNull: true
  },
  
  // For University - research interests
  researchInterests: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  
  specialization: DataTypes.STRING, // Keep for backward compatibility
  
  // Subjects/Units taught
  subjects: { 
    type: DataTypes.JSONB, 
    defaultValue: [] 
  },
  
  // Units they are assigned to teach (for University/TVET)
  unitIds: {
    type: DataTypes.JSONB,
    defaultValue: []
  },
  
  staffType: { 
    type: DataTypes.ENUM(
      'TEACHING', 
      'NON_TEACHING', 
      'ACADEMIC',      // For university lecturers
      'RESEARCH',       // For research staff
      'TECHNICAL',      // For lab/workshop staff
      'ADMINISTRATIVE'  // For deans, HODs, etc.
    ), 
    defaultValue: 'TEACHING' 
  },

  // For HR purposes
  employmentType: {
    type: DataTypes.ENUM(
      'PERMANENT',
      'CONTRACT',
      'PART_TIME',
      'VISITING',
      'INTERN',
      'CONSULTANT'
    ),
    defaultValue: 'PERMANENT'
  },

  contractEndDate: DataTypes.DATEONLY,

  // Bank Details
  bankDetails: {
    type: DataTypes.JSONB,
    defaultValue: {
      bank: '',
      branch: '',
      account: '',
      paybill: ''
    }
  },
  
  // Deductions
  deductions: {
    type: DataTypes.JSONB,
    defaultValue: {
      nhif: 0,
      nssf: 0,
      sacco: 0,
      helb: 0,
      pension: 0,
      union: 0
    }
  },
  
  // Salary Structure
  salary: {
    type: DataTypes.JSONB,
    defaultValue: {
      basic: 0,
      house: 0,
      transport: 0,
      medical: 0,
      commuter: 0,
      leave: 0,
      hardship: 0,
      responsibility: 0,  // For HOD/Dean allowances
      research: 0,         // Research allowance
      extraneous: 0
    }
  },

  // For research staff
  researchGrants: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  // For lab/workshop staff
  managedLabs: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  managedWorkshops: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  // Certifications/Licenses
  certifications: {
    type: DataTypes.JSONB,
    defaultValue: []
  },

  // Emergency contact
  emergencyContact: {
    type: DataTypes.JSONB,
    defaultValue: {
      name: '',
      relationship: '',
      phone: '',
      email: ''
    }
  },

  // Status
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Payroll = sequelize.define('Payroll', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  staffId: { type: DataTypes.UUID, allowNull: false },
  month: DataTypes.INTEGER,
  year: DataTypes.INTEGER,
  grossPay: DataTypes.DECIMAL(10, 2),
  deductions: DataTypes.DECIMAL(10, 2),
  netPay: DataTypes.DECIMAL(10, 2),
  paymentDate: DataTypes.DATEONLY,
  status: {
    type: DataTypes.ENUM('PENDING', 'PAID', 'CANCELLED'),
    defaultValue: 'PENDING'
  }
});

const Book = sequelize.define('Book', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  title: DataTypes.STRING,
  author: DataTypes.STRING,
  isbn: DataTypes.STRING,
  publisher: DataTypes.STRING,
  year: DataTypes.INTEGER,
  category: DataTypes.STRING,
  quantity: { type: DataTypes.INTEGER, defaultValue: 1 },
  available: { type: DataTypes.INTEGER, defaultValue: 1 },
  location: DataTypes.STRING,
  shelf: DataTypes.STRING
});

const Borrow = sequelize.define('Borrow', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  bookId: { type: DataTypes.UUID, allowNull: false },
  studentId: DataTypes.UUID,
  staffId: DataTypes.UUID,
  borrowDate: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
  dueDate: DataTypes.DATEONLY,
  returnDate: DataTypes.DATEONLY,
  status: {
    type: DataTypes.ENUM('BORROWED', 'RETURNED', 'OVERDUE', 'LOST')
  },
  fine: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 }
});

const Vehicle = sequelize.define('Vehicle', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  registration: DataTypes.STRING,
  type: DataTypes.STRING,
  capacity: DataTypes.INTEGER,
  driver: DataTypes.STRING,
  driverPhone: DataTypes.STRING,
  insuranceExpiry: DataTypes.DATEONLY,
  serviceDue: DataTypes.DATEONLY,
  fuelType: DataTypes.STRING,
  status: {
    type: DataTypes.ENUM('ACTIVE', 'MAINTENANCE', 'INACTIVE'),
    defaultValue: 'ACTIVE'
  }
});

const TransportRoute = sequelize.define('TransportRoute', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  name: DataTypes.STRING,
  vehicleId: { type: DataTypes.UUID, allowNull: true },
  pickupPoints: { type: DataTypes.JSONB, defaultValue: [] },
  pickupTimes: { type: DataTypes.JSONB, defaultValue: [] },
  dropoffPoints: { type: DataTypes.JSONB, defaultValue: [] },
  fee: DataTypes.DECIMAL(10, 2),
  students: { type: DataTypes.JSONB, defaultValue: [] },
  autoAllocate: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Hostel = sequelize.define('Hostel', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  name: DataTypes.STRING,
  gender: DataTypes.ENUM('BOYS', 'GIRLS', 'MIXED'),
  capacity: DataTypes.INTEGER,
  warden: DataTypes.STRING,
  wardenPhone: DataTypes.STRING,
  rooms: { 
    type: DataTypes.JSONB,
    defaultValue: [],
    get() {
      const rawValue = this.getDataValue('rooms');
      if (!rawValue) return [];
      if (typeof rawValue === 'string') {
        try {
          return JSON.parse(rawValue);
        } catch (e) {
          return [];
        }
      }
      return rawValue;
    },
    set(value) {
      this.setDataValue('rooms', value || []);
    }
  }
}, {
  timestamps: true,
  hooks: {
    beforeSave: (hostel) => {
      if (!hostel.rooms) hostel.rooms = [];
      if (!Array.isArray(hostel.rooms)) hostel.rooms = [];
    }
  }
});

const Inventory = sequelize.define('Inventory', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  name: DataTypes.STRING,
  category: DataTypes.STRING,
  quantity: DataTypes.INTEGER,
  unit: DataTypes.STRING,
  unitPrice: DataTypes.DECIMAL(10, 2),
  totalValue: DataTypes.DECIMAL(10, 2),
  reorderLevel: DataTypes.INTEGER,
  supplier: DataTypes.STRING,
  location: DataTypes.STRING,
  lastOrdered: DataTypes.DATEONLY,
  notes: DataTypes.TEXT
});

const InventoryUsage = sequelize.define('InventoryUsage', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  inventoryId: { type: DataTypes.UUID, allowNull: false },
  quantity: { type: DataTypes.INTEGER, allowNull: false },
  reason: DataTypes.STRING,
  department: DataTypes.STRING,
  usedBy: DataTypes.UUID,
  date: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  timestamps: true,
  underscored: false
});

const Timetable = sequelize.define('Timetable', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  classId: { type: DataTypes.UUID, allowNull: true }, 
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true }, // ADD THIS FOR TVET
  unitId: { type: DataTypes.UUID, allowNull: true },
  subjectId: { type: DataTypes.UUID, allowNull: true },
  year: { type: DataTypes.INTEGER, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  module: { type: DataTypes.INTEGER, allowNull: true }, // ADD THIS FOR TVET
  day: { 
    type: DataTypes.ENUM('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'),
    allowNull: false 
  },
  period: { type: DataTypes.INTEGER, allowNull: false },
  startTime: { type: DataTypes.TIME, allowNull: false },
  endTime: { type: DataTypes.TIME, allowNull: false },
  teacherId: { type: DataTypes.UUID, allowNull: false },
  room: { type: DataTypes.STRING, allowNull: true }
});
const Message = sequelize.define('Message', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  type: DataTypes.ENUM('SMS', 'EMAIL', 'NOTIFICATION'),
  from: DataTypes.UUID,
  to: { type: DataTypes.JSONB, defaultValue: [] },
  subject: DataTypes.STRING,
  content: DataTypes.TEXT,
  status: DataTypes.STRING,
  sentAt: DataTypes.DATE
});

const Announcement = sequelize.define('Announcement', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  title: DataTypes.STRING,
  content: DataTypes.TEXT,
  audience: { type: DataTypes.JSONB, defaultValue: [] },
  createdBy: DataTypes.UUID,
  expiresAt: DataTypes.DATE,
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Event = sequelize.define('Event', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  title: DataTypes.STRING,
  description: DataTypes.TEXT,
  startDate: DataTypes.DATE,
  endDate: DataTypes.DATE,
  location: DataTypes.STRING,
  type: DataTypes.STRING,
  audience: { type: DataTypes.JSONB, defaultValue: [] },
  createdBy: DataTypes.UUID
});

const AuditLog = sequelize.define('AuditLog', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  schoolId: DataTypes.UUID,
  userId: DataTypes.UUID,
  action: DataTypes.STRING,
  entity: DataTypes.STRING,
  entityId: DataTypes.UUID,
  oldValue: DataTypes.JSONB,
  newValue: DataTypes.JSONB,
  ipAddress: DataTypes.STRING,
  userAgent: DataTypes.STRING,
  timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

const Feature = sequelize.define('Feature', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: DataTypes.STRING,
  code: DataTypes.STRING,
  category: DataTypes.STRING,
  description: DataTypes.TEXT,
  isEnabled: { type: DataTypes.BOOLEAN, defaultValue: false },
  schoolId: DataTypes.UUID
});

const Faculty = sequelize.define('Faculty', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  dean: DataTypes.STRING,
  email: DataTypes.STRING,
  phone: DataTypes.STRING,
  established: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Department = sequelize.define('Department', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  facultyId: { type: DataTypes.UUID, allowNull: false },
  head: DataTypes.STRING,
  email: DataTypes.STRING,
  phone: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Course = sequelize.define('Course', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: DataTypes.STRING,
  departmentId: { type: DataTypes.UUID, allowNull: false },
  credits: DataTypes.INTEGER,
  level: DataTypes.STRING,
  description: DataTypes.TEXT,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Program = sequelize.define('Program', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  code: DataTypes.STRING,
  departmentId: { type: DataTypes.UUID, allowNull: false },
  duration: DataTypes.INTEGER,
  level: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Lab = sequelize.define('Lab', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  departmentId: { type: DataTypes.UUID, allowNull: false },
  incharge: DataTypes.STRING,
  capacity: DataTypes.INTEGER,
  location: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Research = sequelize.define('Research', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  title: { type: DataTypes.STRING, allowNull: false },
  facultyId: { type: DataTypes.UUID, allowNull: false },
  researcher: DataTypes.STRING,
  startDate: DataTypes.DATEONLY,
  endDate: DataTypes.DATEONLY,
  funding: DataTypes.STRING,
  status: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Sponsor = sequelize.define('Sponsor', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false },
  organization: DataTypes.STRING,
  email: DataTypes.STRING,
  phone: DataTypes.STRING,
  address: DataTypes.TEXT,
  contactPerson: DataTypes.STRING,
  sponsorType: {
    type: DataTypes.ENUM('INDIVIDUAL', 'ORGANIZATION', 'GOVERNMENT', 'NGO', 'OTHER'),
    defaultValue: 'INDIVIDUAL'
  },
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const Maintenance = sequelize.define('Maintenance', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  vehicleId: { type: DataTypes.UUID, allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  type: DataTypes.STRING,
  description: DataTypes.TEXT,
  cost: DataTypes.DECIMAL(10, 2),
  odometer: DataTypes.INTEGER,
  nextDueDate: DataTypes.DATEONLY,
  notes: DataTypes.TEXT,
  performedBy: DataTypes.STRING,
  schoolId: { type: DataTypes.UUID, allowNull: false }
});

const StudentSponsor = sequelize.define('StudentSponsor', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  sponsorId: { type: DataTypes.UUID, allowNull: false },
  sponsorshipType: {
    type: DataTypes.ENUM('FULL', 'PARTIAL'),
    defaultValue: 'FULL'
  },
  amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  startDate: DataTypes.DATEONLY,
  endDate: DataTypes.DATEONLY,
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const StaffAttendance = sequelize.define('StaffAttendance', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  staffId: { type: DataTypes.UUID, allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  status: {
    type: DataTypes.ENUM('PRESENT', 'ABSENT', 'LATE', 'LEAVE', 'HOLIDAY', 'REMOTE', 'OFF')
  },
  timeIn: DataTypes.TIME,
  timeOut: DataTypes.TIME,
  remarks: DataTypes.TEXT,
  markedBy: DataTypes.UUID,
  approved: { type: DataTypes.BOOLEAN, defaultValue: false },
  approvalStatus: { 
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED'),
    defaultValue: 'PENDING'
  },
  approvedBy: DataTypes.UUID,
  approvedAt: DataTypes.DATE
});
// Add these model definitions after your existing models (around line 1400)

const HealthRecords = sequelize.define('HealthRecords', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  temperature: { type: DataTypes.DECIMAL(4, 1), allowNull: true },
  bloodPressure: { type: DataTypes.STRING(20), allowNull: true },
  weight: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
  height: { type: DataTypes.DECIMAL(5, 1), allowNull: true },
  symptoms: { type: DataTypes.TEXT, allowNull: true },
  diagnosis: { type: DataTypes.TEXT, allowNull: false },
  prescription: { type: DataTypes.TEXT, allowNull: true },
  followUpDate: { type: DataTypes.DATEONLY, allowNull: true },
  notes: { type: DataTypes.TEXT, allowNull: true },
  status: { type: DataTypes.STRING(50), defaultValue: 'TREATED' },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  recordedBy: { type: DataTypes.UUID, allowNull: true }
}, {
  tableName: 'HealthRecords',
  timestamps: true
});

const SchemesOfWork = sequelize.define('SchemesOfWork', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  
  // Regular School fields - allow null
  classId: { type: DataTypes.UUID, allowNull: true },  // ← Change from allowNull: false
  subjectId: { type: DataTypes.UUID, allowNull: true }, // ← Change from allowNull: false
  
  // University fields
  courseId: { type: DataTypes.UUID, allowNull: true },
  unitId: { type: DataTypes.UUID, allowNull: true },
  
  // TVET fields
  programId: { type: DataTypes.UUID, allowNull: true },
  moduleId: { type: DataTypes.UUID, allowNull: true },
  
  // Common fields - these stay required
  period: { type: DataTypes.STRING(100), allowNull: false },
  week: { type: DataTypes.STRING(100), allowNull: false },
  topic: { type: DataTypes.STRING(255), allowNull: false },
  subTopic: { type: DataTypes.STRING(255), allowNull: true },
  objectives: { type: DataTypes.TEXT, allowNull: true },
  teachingActivities: { type: DataTypes.TEXT, allowNull: true },
  learningActivities: { type: DataTypes.TEXT, allowNull: true },
  resources: { type: DataTypes.TEXT, allowNull: true },
  assessment: { type: DataTypes.TEXT, allowNull: true },
  remarks: { type: DataTypes.TEXT, allowNull: true },
  covered: { type: DataTypes.BOOLEAN, defaultValue: false },
  dateCovered: { type: DataTypes.DATEONLY, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false },
  createdBy: { type: DataTypes.UUID, allowNull: true }
}, {
  tableName: 'SchemesOfWork',
  timestamps: true
});
// ==================== COURSE ENROLLMENT MODEL ====================
const CourseEnrollment = sequelize.define('CourseEnrollment', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  enrollmentDate: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
  academicYear: { type: DataTypes.STRING, allowNull: false },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  status: {
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'DROPPED', 'COMPLETED'),
    defaultValue: 'PENDING'
  },
  approvedBy: { type: DataTypes.UUID, allowNull: true },
  approvedAt: { type: DataTypes.DATE, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false }
}, {
  timestamps: true
});

// ==================== UNIT REGISTRATION MODEL ====================
const UnitRegistration = sequelize.define('UnitRegistration', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  studentId: { type: DataTypes.UUID, allowNull: false },
  unitId: { type: DataTypes.UUID, allowNull: false },
  courseId: { type: DataTypes.UUID, allowNull: true },
  programId: { type: DataTypes.UUID, allowNull: true },
  semester: { type: DataTypes.INTEGER, allowNull: true },
  academicYear: { type: DataTypes.STRING, allowNull: false },
  registrationDate: { type: DataTypes.DATEONLY, defaultValue: DataTypes.NOW },
  status: {
    type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'DROPPED', 'COMPLETED'),
    defaultValue: 'PENDING'
  },
  approvedBy: { type: DataTypes.UUID, allowNull: true },
  approvedAt: { type: DataTypes.DATE, allowNull: true },
  schoolId: { type: DataTypes.UUID, allowNull: false }
}, {
  timestamps: true
});
// Add associations
HealthRecords.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(HealthRecords, { foreignKey: 'studentId' });
// ==================== SCHEMES OF WORK ASSOCIATIONS - FIXED ====================
// ==================== COURSE ENROLLMENT ASSOCIATIONS ====================
CourseEnrollment.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(CourseEnrollment, { foreignKey: 'studentId' });

CourseEnrollment.belongsTo(Course, { foreignKey: 'courseId' });
Course.hasMany(CourseEnrollment, { foreignKey: 'courseId' });

CourseEnrollment.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(CourseEnrollment, { foreignKey: 'programId' });

CourseEnrollment.belongsTo(User, { as: 'approver', foreignKey: 'approvedBy' });
CourseEnrollment.belongsTo(School, { foreignKey: 'schoolId' });

// ==================== UNIT REGISTRATION ASSOCIATIONS ====================
UnitRegistration.belongsTo(Student, { foreignKey: 'studentId' });
Student.hasMany(UnitRegistration, { foreignKey: 'studentId' });

UnitRegistration.belongsTo(CourseUnit, { foreignKey: 'unitId' });
CourseUnit.hasMany(UnitRegistration, { foreignKey: 'unitId' });

UnitRegistration.belongsTo(Course, { foreignKey: 'courseId' });
Course.hasMany(UnitRegistration, { foreignKey: 'courseId' });

UnitRegistration.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(UnitRegistration, { foreignKey: 'programId' });

UnitRegistration.belongsTo(User, { as: 'approver', foreignKey: 'approvedBy' });
UnitRegistration.belongsTo(School, { foreignKey: 'schoolId' });
// Regular School associations
SchemesOfWork.belongsTo(Class, { foreignKey: 'classId' });
SchemesOfWork.belongsTo(Subject, { foreignKey: 'subjectId' });
Class.hasMany(SchemesOfWork, { foreignKey: 'classId' });
Subject.hasMany(SchemesOfWork, { foreignKey: 'subjectId' });

// University associations
SchemesOfWork.belongsTo(Course, { foreignKey: 'courseId' });
SchemesOfWork.belongsTo(CourseUnit, { as: 'unit', foreignKey: 'unitId' });  // Using 'unit' as alias
Course.hasMany(SchemesOfWork, { foreignKey: 'courseId' });
CourseUnit.hasMany(SchemesOfWork, { as: 'units', foreignKey: 'unitId' });  // Using 'units' as alias

// TVET associations - USE DIFFERENT ALIASES to avoid conflict
SchemesOfWork.belongsTo(Program, { foreignKey: 'programId' });
SchemesOfWork.belongsTo(CourseUnit, { as: 'tvetModule', foreignKey: 'moduleId' });  // Alias 'tvetModule'
Program.hasMany(SchemesOfWork, { foreignKey: 'programId' });
CourseUnit.hasMany(SchemesOfWork, { as: 'tvetModules', foreignKey: 'moduleId' });  // Alias 'tvetModules'
// School relationships
School.hasMany(User, { foreignKey: 'schoolId' });
User.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Class, { foreignKey: 'schoolId' });
Class.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Student, { foreignKey: 'schoolId' });
Student.belongsTo(School, { foreignKey: 'schoolId' });

// Student belongs to User
Student.belongsTo(User, { foreignKey: 'userId' });
User.hasMany(Student, { foreignKey: 'userId' });
School.hasMany(Subject, { foreignKey: 'schoolId' });
Subject.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Exam, { foreignKey: 'schoolId' });
Exam.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Fee, { foreignKey: 'schoolId' });
Fee.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Expense, { foreignKey: 'schoolId' });
Expense.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Vehicle, { foreignKey: 'schoolId' });
Vehicle.belongsTo(School, { foreignKey: 'schoolId' });
// In your Exam model definition, you should have something like:
// ==================== FIXED EXAM MODEL ASSOCIATIONS ====================
// In your server.cjs file, find where Exam associations are defined (around line 1393)

// FIXED: Use unique aliases for each association
Exam.belongsTo(Course, { 
  as: 'course', 
  foreignKey: 'courseId' 
});

Exam.belongsTo(Program, { 
  as: 'program', 
  foreignKey: 'programId' 
});

// FIXED: Use 'courseUnit' instead of 'unit' to avoid duplicate alias
Exam.belongsTo(CourseUnit, { 
  as: 'courseUnit',  // Changed from 'unit' to 'courseUnit'
  foreignKey: 'unitId' 
});

Exam.belongsTo(Class, { 
  as: 'class', 
  foreignKey: 'classId' 
});

Exam.belongsTo(Subject, { 
  as: 'subject', 
  foreignKey: 'subjectId' 
});

Exam.belongsTo(Faculty, { 
  as: 'faculty', 
  foreignKey: 'facultyId' 
});

Exam.belongsTo(Department, { 
  as: 'department', 
  foreignKey: 'departmentId' 
});

School.hasMany(Hostel, { foreignKey: 'schoolId' });
Hostel.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Inventory, { foreignKey: 'schoolId' });
Inventory.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Book, { foreignKey: 'schoolId' });
Book.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Announcement, { foreignKey: 'schoolId' });
Announcement.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Event, { foreignKey: 'schoolId' });
Event.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Feature, { foreignKey: 'schoolId' });
Feature.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Faculty, { foreignKey: 'schoolId' });
Faculty.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(Program, { foreignKey: 'schoolId' });
Program.belongsTo(School, { foreignKey: 'schoolId' });

School.hasMany(CourseUnit, { foreignKey: 'schoolId' });
CourseUnit.belongsTo(School, { foreignKey: 'schoolId' });

Program.belongsTo(Department, { foreignKey: 'departmentId' });
Department.hasMany(Program, { foreignKey: 'departmentId' });
School.hasMany(Timetable, { foreignKey: 'schoolId' });
Timetable.belongsTo(School, { foreignKey: 'schoolId' });

// Add these where you define your associations
Timetable.hasMany(Attendance, { foreignKey: 'timetableId' });
Attendance.belongsTo(Timetable, { foreignKey: 'timetableId' });

CourseUnit.hasMany(Attendance, { foreignKey: 'unitId' });
Attendance.belongsTo(CourseUnit, { foreignKey: 'unitId' });

// University/TVET relationships
Faculty.hasMany(Department, { foreignKey: 'facultyId' });
Department.belongsTo(Faculty, { foreignKey: 'facultyId' });

Department.hasMany(Course, { foreignKey: 'departmentId' });
Course.belongsTo(Department, { foreignKey: 'departmentId' });

Department.hasMany(Program, { foreignKey: 'departmentId' });
Program.belongsTo(Department, { foreignKey: 'departmentId' });
// Add these associations where you define your relationships
Timetable.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(Timetable, { foreignKey: 'programId' });
Course.hasMany(CourseUnit, { foreignKey: 'courseId' });
CourseUnit.belongsTo(Course, { foreignKey: 'courseId' });
Exam.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(Exam, { foreignKey: 'programId' });
Department.hasMany(Lab, { foreignKey: 'departmentId' });
Lab.belongsTo(Department, { foreignKey: 'departmentId' });

Faculty.hasMany(Research, { foreignKey: 'facultyId' });
Research.belongsTo(Faculty, { foreignKey: 'facultyId' });

// Class relationships
Class.hasMany(Student, { foreignKey: 'classId' });
Student.belongsTo(Class, { foreignKey: 'classId' });

Class.hasMany(Subject, { foreignKey: 'classId' });
Subject.belongsTo(Class, { foreignKey: 'classId' });

Class.hasMany(Timetable, { foreignKey: 'classId' });
Timetable.belongsTo(Class, { foreignKey: 'classId' });

Class.belongsTo(User, { as: 'classTeacher', foreignKey: 'classTeacherId' });

// Student relationships
Student.hasMany(Result, { foreignKey: 'studentId' });
Result.belongsTo(Student, { foreignKey: 'studentId' });

Student.hasMany(Attendance, { foreignKey: 'studentId' });
Attendance.belongsTo(Student, { foreignKey: 'studentId' });

Student.hasMany(Payment, { foreignKey: 'studentId' });
Payment.belongsTo(Student, { foreignKey: 'studentId' });

Student.hasMany(Parent, { foreignKey: 'studentId' });
Parent.belongsTo(Student, { foreignKey: 'studentId' });

Student.belongsTo(TransportRoute, { foreignKey: 'transportRouteId' });
Student.belongsTo(Course, { foreignKey: 'courseId' });
Student.belongsTo(Program, { foreignKey: 'programId' });
Student.belongsTo(Hostel, { foreignKey: 'hostelId' });

// User relationships
User.hasOne(Staff, { foreignKey: 'userId' });
Staff.belongsTo(User, { foreignKey: 'userId' });
// Add these associations
Staff.belongsTo(Department, { as: 'managedDepartment', foreignKey: 'managesDepartmentId' });
Staff.belongsTo(Faculty, { as: 'managedFaculty', foreignKey: 'managesFacultyId' });

Staff.belongsTo(Department, { foreignKey: 'departmentId' });
Staff.belongsTo(Faculty, { foreignKey: 'facultyId' });

// For HOD/Dean relationships
Department.belongsTo(Staff, { as: 'headOfDepartment', foreignKey: 'headOfDepartmentId' });
Faculty.belongsTo(Staff, { as: 'facultyDean', foreignKey: 'deanId' });
User.hasMany(Parent, { foreignKey: 'userId' });
Parent.belongsTo(User, { foreignKey: 'userId' });

// Exam relationships
Exam.belongsTo(Class, { foreignKey: 'classId' });
Exam.belongsTo(Subject, { foreignKey: 'subjectId' });
Exam.belongsTo(Course, { foreignKey: 'courseId' });
Exam.belongsTo(CourseUnit, { foreignKey: 'unitId', as: 'unit' });
Exam.belongsTo(Faculty, { foreignKey: 'facultyId' });
Exam.belongsTo(Department, { foreignKey: 'departmentId' });

Attendance.belongsTo(CourseUnit, { foreignKey: 'unitId', as: 'unit' });
CourseUnit.hasMany(Attendance, { foreignKey: 'unitId' });

Attendance.belongsTo(Subject, { foreignKey: 'subjectId' });
Subject.hasMany(Attendance, { foreignKey: 'subjectId' });

Attendance.belongsTo(Timetable, { foreignKey: 'timetableId' });
Timetable.hasMany(Attendance, { foreignKey: 'timetableId' });
// Result relationships
Result.belongsTo(Exam, { foreignKey: 'examId' });
Result.belongsTo(Subject, { foreignKey: 'subjectId' });
Result.belongsTo(CourseUnit, { foreignKey: 'unitId', as: 'CourseUnit' });

// Subject relationships
Subject.belongsTo(User, { as: 'teacher', foreignKey: 'teacherId' });

// Fee relationships
Fee.belongsTo(Class, { foreignKey: 'classId' });
Fee.belongsTo(Course, { foreignKey: 'courseId' });
Fee.belongsTo(Faculty, { foreignKey: 'facultyId' });
Fee.belongsTo(Department, { foreignKey: 'departmentId' });
Fee.belongsTo(Program, { foreignKey: 'programId' });
Fee.belongsTo(TransportRoute, { foreignKey: 'transportRouteId' });

// Payment relationships
Payment.belongsTo(Fee, { foreignKey: 'feeId' });

// Timetable relationships
Timetable.belongsTo(Subject, { foreignKey: 'subjectId' });
Timetable.belongsTo(CourseUnit, { foreignKey: 'unitId', as: 'unit' });
Timetable.belongsTo(Staff, { as: 'teacher', foreignKey: 'teacherId' });  
Timetable.belongsTo(Course, { foreignKey: 'courseId' });
Timetable.belongsTo(Class, { foreignKey: 'classId' });

// Transport relationships
TransportRoute.belongsTo(Vehicle, { foreignKey: 'vehicleId' });
TransportRoute.hasMany(Student, { foreignKey: 'transportRouteId' });

// Vehicle relationships
Vehicle.hasMany(TransportRoute, { foreignKey: 'vehicleId' });
Vehicle.hasMany(Maintenance, { foreignKey: 'vehicleId' });

// Maintenance relationships
Maintenance.belongsTo(Vehicle, { foreignKey: 'vehicleId' });

// Inventory relationships
Inventory.hasMany(InventoryUsage, { foreignKey: 'inventoryId' });
InventoryUsage.belongsTo(Inventory, { foreignKey: 'inventoryId' });

// Library relationships
Borrow.belongsTo(Book, { foreignKey: 'bookId' });
Borrow.belongsTo(Student, { foreignKey: 'studentId' });

// Payroll relationships
Payroll.belongsTo(Staff, { foreignKey: 'staffId' });

// Attendance relationships
Attendance.belongsTo(Class, { foreignKey: 'classId' });
Attendance.belongsTo(User, { as: 'markedByUser', foreignKey: 'markedBy' });
Attendance.belongsTo(Course, { foreignKey: 'courseId' });

Attendance.belongsTo(Program, { foreignKey: 'programId' });
Program.hasMany(Attendance, { foreignKey: 'programId' });
// Audit log relationships
AuditLog.belongsTo(User, { foreignKey: 'userId' });

// Staff Attendance relationships
StaffAttendance.belongsTo(Staff, { foreignKey: 'staffId' });
Staff.hasMany(StaffAttendance, { foreignKey: 'staffId' });

// Sponsor relationships
Sponsor.belongsTo(School, { foreignKey: 'schoolId' });
Sponsor.belongsToMany(Student, { through: StudentSponsor, foreignKey: 'sponsorId' });
Student.belongsToMany(Sponsor, { through: StudentSponsor, foreignKey: 'studentId' });
CourseUnit.belongsTo(Course, { foreignKey: 'courseId' });
CourseUnit.belongsTo(Program, { foreignKey: 'programId' });
// ==================== PERMISSION DEFINITIONS ====================
const PERMISSIONS = {
  SUPER_ADMIN: '*',
  SCHOOL_ADMIN: [
    'manage_school',
    'manage_users',
    'manage_students',
    'manage_classes',
    'manage_subjects',
    'manage_exams',
    'manage_results',
    'manage_attendance',
    'manage_fees',
    'manage_payments',
    'manage_staff',
    'manage_payroll',
    'manage_library',
    'manage_transport',
    'manage_hostel',
    'manage_inventory',
    'manage_announcements',
    'manage_events',
    'manage_timetable',
    'view_reports',
    'view_financial_reports',
    'view_attendance',
    'view_results'
  ],
  PRINCIPAL: [
    'view_students',
    'view_classes',
    'view_subjects',
    'view_exams',
    'view_results',
    'view_attendance',
    'view_fees',
    'view_payments',
    'view_staff',
    'view_library',
    'view_transport',
    'view_hostel',
    'view_inventory',
    'view_announcements',
    'view_events',
    'view_timetable',
    'view_reports'
  ],
  DEPUTY_PRINCIPAL: [
    'view_students',
    'view_classes',
    'view_subjects',
    'view_exams',
    'view_results',
    'view_attendance',
    'view_fees',
    'view_payments',
    'view_staff',
    'view_library',
    'view_transport',
    'view_hostel',
    'view_inventory',
    'view_announcements',
    'view_events',
    'view_timetable',
    'view_reports'
  ],
  SENIOR_TEACHER: [
    'view_students',
    'view_classes',
    'manage_own_subjects',
    'manage_own_results',
    'manage_own_attendance',
    'view_timetable'
  ],
  CLASS_TEACHER: [
    'view_students',
    'view_own_class',
    'manage_own_results',
    'manage_own_attendance',
    'view_timetable'
  ],
  SUBJECT_TEACHER: [
    'view_students',
    'manage_own_subjects',
    'manage_own_results',
    'manage_own_attendance',
    'view_timetable'
  ],
  TEACHER: [
    'view_students',
    'manage_own_results',
    'manage_own_attendance',
    'view_timetable'
  ],
  ACCOUNTANT: [
    'view_fees',
    'manage_payments',
    'view_financial_reports',
    'manage_expenses'
  ],
  LIBRARIAN: [
    'manage_library',
    'view_books',
    'manage_borrowing'
  ],
  NURSE: [
    'view_students',
    'manage_medical_records'
  ],
  MATRON: [
    'view_students',
    'manage_hostel'
  ],
  TRANSPORT_MANAGER: [
    'manage_transport',
    'view_students',
    'view_vehicles'
  ],
  PARENT: [
    'view_own_children',
    'view_child_results',
    'view_child_attendance',
    'view_child_fees',
    'view_child_timetable'
  ],
  STUDENT: [
    'view_own_profile',
    'view_own_results',
    'view_own_attendance',
    'view_own_fees',
    'view_own_timetable'
  ]
};

const getPermissionsForRole = (role) => {
  if (role === 'SUPER_ADMIN') return ['*'];
  return PERMISSIONS[role] || [];
};

// ==================== PERMISSION MIDDLEWARE ====================
const checkPermission = (requiredPermission) => {
  return (req, res, next) => {
    const userRole = req.user.role;
    const permissions = getPermissionsForRole(userRole);

    if (permissions.includes('*')) return next();
    if (!permissions.includes(requiredPermission)) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. Insufficient permissions.' 
      });
    }
    next();
  };
};

// ==================== HELPER FUNCTIONS ====================

const generateAdmissionNumber = async (schoolId) => {
  const year = new Date().getFullYear();
  const lastStudent = await Student.findOne({
    where: { schoolId },
    order: [['createdAt', 'DESC']]
  });
  
  let sequence = 1;
  if (lastStudent) {
    const lastNum = parseInt(lastStudent.admissionNumber.split('-')[1]);
    sequence = lastNum + 1;
  }
  
  return `${year}-${sequence.toString().padStart(4, '0')}`;
};

// Fix the generateReceiptNo function in your backend (server.cjs)

const generateReceiptNo = async () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  
  try {
    // Get the last payment to determine the sequence
    const lastPayment = await Payment.findOne({ 
      order: [['createdAt', 'DESC']],
      where: {} 
    });
    
    let sequence = 1;
    if (lastPayment && lastPayment.receiptNo) {
      const parts = lastPayment.receiptNo.split('-');
      if (parts.length >= 4) {
        const lastSeq = parseInt(parts[3]);
        if (!isNaN(lastSeq)) {
          sequence = lastSeq + 1;
        }
      } else {
        // If format is different, generate a random sequence
        sequence = Math.floor(Math.random() * 9000) + 1000;
      }
    }
    
    // Add milliseconds to ensure uniqueness
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    
    return `RCP-${year}${month}${day}-${sequence.toString().padStart(4, '0')}-${ms}`;
  } catch (error) {
    console.error('Error generating receipt number:', error);
    // Fallback to timestamp-based receipt number
    return `RCP-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  }
};
const getGradingSystem = (schoolCategory) => {
  switch(schoolCategory) {
    case 'ECDE_PRIMARY_JSS':
      return GRADING_SYSTEMS.CBC;
    case 'SENIOR_SECONDARY':
      return GRADING_SYSTEMS.KENYA_844;
    case 'COLLEGE_TVET':
      return GRADING_SYSTEMS.TVET;
    case 'UNIVERSITY':
      return GRADING_SYSTEMS.UNIVERSITY;
    default:
      return GRADING_SYSTEMS.CBC;
  }
};

const calculateGradeFromMarks = (marks, schoolCategory, maxMarks = 100) => {
  const percentage = (marks / maxMarks) * 100;
  const gradingSystem = getGradingSystem(schoolCategory);
  return gradingSystem.getGrade(percentage);
};

const calculateGross = (salary) => {
  if (!salary) return 0;
  return (
    (parseFloat(salary.basic) || 0) +
    (parseFloat(salary.house) || 0) +
    (parseFloat(salary.transport) || 0) +
    (parseFloat(salary.medical) || 0) +
    (parseFloat(salary.commuter) || 0) +
    (parseFloat(salary.leave) || 0) +
    (parseFloat(salary.hardship) || 0)
  );
};

const calculateDeductions = (deductions) => {
  if (!deductions) return 0;
  return (
    (parseFloat(deductions.nhif) || 0) +
    (parseFloat(deductions.nssf) || 0) +
    (parseFloat(deductions.sacco) || 0) +
    (parseFloat(deductions.helb) || 0)
  );
};

const calculateGPA = (results, schoolCategory) => {
  if (!results || !results.length) return 0;
  const gradingSystem = getGradingSystem(schoolCategory);
  if (gradingSystem.isGPABased) {
    const totalPoints = results.reduce((sum, r) => sum + (r.points || 0), 0);
    return (totalPoints / results.length).toFixed(2);
  }
  return 0;
};

const calculateMeanGrade = (results, schoolCategory) => {
  if (!results || !results.length) return 'N/A';
  const gradingSystem = getGradingSystem(schoolCategory);
  if (gradingSystem.calculateMeanGrade) {
    const totalPoints = results.reduce((sum, r) => sum + (r.points || 0), 0);
    return gradingSystem.calculateMeanGrade(totalPoints);
  }
  return 'N/A';
};

const sendEmail = async (to, subject, html) => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      html
    });
    
    return true;
  } catch (error) {
    console.error('Email send error:', error);
    return false;
  }
};

const createAuditLog = async (req, action, entity, entityId, oldValue = null, newValue = null) => {
  try {
    let userId = null;
    let userEmail = 'System';
    
    if (req && req.user) {
      userId = req.user.id;
      userEmail = req.user.email || 'System';
      
      console.log(`📝 Creating audit log for user: ${req.user.firstName} ${req.user.lastName} (${req.user.email})`);
    } else {
      console.log('⚠️ No user found in request for audit log');
    }

    const logData = {
      schoolId: req?.user?.schoolId || null,
      userId: userId,
      action,
      entity,
      entityId,
      oldValue: oldValue ? JSON.parse(JSON.stringify(oldValue)) : null,
      newValue: newValue ? JSON.parse(JSON.stringify(newValue)) : null,
      ipAddress: req?.ip || req?.connection?.remoteAddress || null,
      userAgent: req?.get ? req.get('User-Agent') : null,
      timestamp: new Date()
    };

    console.log(`📝 Creating audit log: ${action} ${entity} by ${userEmail}`);

    await AuditLog.create(logData);
    console.log('✅ Audit log created successfully');
  } catch (error) {
    console.error('❌ Audit log error:', error);
  }
};

const checkStudentAccess = async (studentId, user) => {
  if (user.role === 'SUPER_ADMIN') return true;
  if (user.role === 'STUDENT') {
    const student = await Student.findOne({ where: { userId: user.id } });
    return student && student.id === studentId;
  }
  if (user.role === 'PARENT') {
    const parent = await Parent.findOne({ where: { userId: user.id, studentId } });
    return !!parent;
  }
  return true;
};

// ==================== MIDDLEWARE ====================

const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Authentication required' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.id);
    
    if (!user || !user.isActive) return res.status(401).json({ message: 'User not found or inactive' });

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
};

const requireSchoolAdmin = (req, res, next) => {
  if (req.user.role !== 'SCHOOL_ADMIN' && req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'Access denied. School admin only.' });
  }
  next();
};

const requireSuperAdmin = (req, res, next) => {
  if (req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({ message: 'Access denied. Super admin only.' });
  }
  next();
};

const checkSchoolAccess = (req, res, next) => {
  const schoolId = req.params.schoolId || req.body.schoolId;
  
  if (req.user.role === 'SUPER_ADMIN') return next();
  
  if (req.user.schoolId !== schoolId) {
    return res.status(403).json({ message: 'Access denied to this school' });
  }
  
  next();
};

// ==================== API ROOT ====================

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Welcome to SchoolAid SaaS API',
    version: '1.0.0',
    gradingSystems: Object.keys(GRADING_SYSTEMS).map(key => ({
      code: key,
      name: GRADING_SYSTEMS[key].name,
      applicableTo: GRADING_SYSTEMS[key].applicableTo
    })),
    endpoints: {
      auth: '/api/auth',
      schools: '/api/schools',
      users: '/api/users',
      classes: '/api/classes',
      students: '/api/students',
      parents: '/api/parents',
      subjects: '/api/subjects',
      exams: '/api/exams',
      results: '/api/results',
      attendance: '/api/attendance',
      fees: '/api/fees',
      payments: '/api/payments',
      staff: '/api/staff',
      library: '/api/books',
      transport: '/api/transport-routes',
      hostel: '/api/hostels',
      inventory: '/api/inventory',
      'inventory-usage': '/api/inventory-usage',
      announcements: '/api/announcements',
      events: '/api/events',
      dashboard: '/api/dashboard/stats',
      'exam-cards': '/api/exam-cards',
      timetable: '/api/timetable',
      'course-units': '/api/course-units',
      promotion: '/api/students/promote',
      'fee-reminders': '/api/fee-reminders/send',
      faculties: '/api/faculties',
      departments: '/api/departments',
      courses: '/api/courses',
      programs: '/api/programs',
      labs: '/api/labs',
      research: '/api/research',
      sponsors: '/api/sponsors',
      'grading-systems': '/api/grading-systems'
    }
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ==================== GRADING SYSTEMS ROUTE ====================

app.get('/api/grading-systems', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.user.schoolId);
    const currentSystem = school ? school.gradingSystem : 'CBC';
    
    res.json({
      success: true,
      gradingSystems: GRADING_SYSTEMS,
      currentSystem,
      schoolCategory: school?.category
    });
  } catch (error) {
    console.error('Get grading systems error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== AUTH ROUTES ====================

app.post('/api/auth/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, firstName, lastName, phone, role } = req.body;

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      email,
      password: hashedPassword,
      firstName,
      lastName,
      phone,
      role: role || 'SCHOOL_ADMIN'
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE }
    );

    user.password = undefined;

    res.status(201).json({ success: true, token, user });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ 
      where: { email },
      include: [{ model: School }]
    });
    
    if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    await user.update({ lastLogin: new Date() });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE }
    );

    user.password = undefined;

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        schoolId: user.schoolId
      },
      school: user.School
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['password'] },
      include: [{ model: School }]
    });
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/auth/change-password', [
  authenticate,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    const user = await User.findByPk(req.user.id);
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    
    if (!isMatch) return res.status(401).json({ message: 'Current password is incorrect' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await user.update({ password: hashedPassword });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ where: { email } });
    
    if (!user) return res.status(404).json({ message: 'User not found' });

    const resetToken = jwt.sign(
      { userId: user.id },
      process.env.JWT_SECRET + user.password,
      { expiresIn: '1h' }
    );

    await user.update({ resetToken });

    const resetLink = `http://localhost:5173/reset-password?token=${resetToken}`;
    console.log('Reset link:', resetLink);

    res.json({ message: 'Password reset email sent' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findByPk(decoded.userId);
    
    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await user.update({ password: hashedPassword, resetToken: null });

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// ==================== CREATE SCHOOL WITH AUTO-SEEDING ====================
app.post('/api/schools', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { name, category, subscription, contact, motto, established, gradingSystem } = req.body;

    const code = name.substring(0, 3).toUpperCase() + Date.now().toString().slice(-4);

    // 1. Create the school
    const school = await School.create({
      name,
      code,
      category,
      gradingSystem: gradingSystem || (() => {
        switch(category) {
          case 'ECDE_PRIMARY_JSS': return 'CBC';
          case 'SENIOR_SECONDARY': return '844';
          case 'COLLEGE_TVET': return 'TVET';
          case 'UNIVERSITY': return 'UNIVERSITY';
          default: return 'CBC';
        }
      })(),
      subscription: subscription || { plan: 'BASIC' },
      contact,
      motto,
      established,
      createdBy: req.user.id
    });

    // 2. Define default features for the new school
    const defaultFeatures = [
      { name: 'SMS Notifications', code: 'SMS', category: 'COMMUNICATION', description: 'Send SMS notifications to parents and staff', isEnabled: true },
      { name: 'Email Notifications', code: 'EMAIL', category: 'COMMUNICATION', description: 'Send email notifications', isEnabled: true },
      { name: 'Online Payments', code: 'ONLINE_PAYMENTS', category: 'FINANCE', description: 'Accept online fee payments', isEnabled: false },
      { name: 'Exam Portal', code: 'EXAM_PORTAL', category: 'ACADEMIC', description: 'Online exam submission and grading', isEnabled: false },
      { name: 'Parent Portal', code: 'PARENT_PORTAL', category: 'ACCESS', description: 'Parent login to view student progress', isEnabled: true },
      { name: 'Student Portal', code: 'STUDENT_PORTAL', category: 'ACCESS', description: 'Student login to view results', isEnabled: true },
      { name: 'Library Management', code: 'LIBRARY', category: 'RESOURCES', description: 'Complete library management system', isEnabled: true },
      { name: 'Transport Tracking', code: 'TRANSPORT', category: 'LOGISTICS', description: 'Real-time vehicle tracking', isEnabled: false },
      { name: 'Hostel Management', code: 'HOSTEL', category: 'ACCOMMODATION', description: 'Hostel room allocation and management', isEnabled: true },
      { name: 'Inventory Management', code: 'INVENTORY', category: 'RESOURCES', description: 'Stock and inventory tracking', isEnabled: true },
      { name: 'Attendance Biometrics', code: 'BIOMETRICS', category: 'ATTENDANCE', description: 'Biometric attendance marking', isEnabled: false },
      { name: 'WhatsApp Integration', code: 'WHATSAPP', category: 'COMMUNICATION', description: 'Send WhatsApp messages', isEnabled: false }
    ];

    // 3. Auto-seed features for the new school
    const seededFeatures = [];
    for (const feature of defaultFeatures) {
      const [featureInstance, created] = await Feature.findOrCreate({
        where: { 
          code: feature.code, 
          schoolId: school.id 
        },
        defaults: { 
          ...feature, 
          schoolId: school.id 
        }
      });
      if (created) {
        seededFeatures.push(featureInstance);
        console.log(`✅ Feature created for ${school.name}: ${feature.name}`);
      }
    }

    // 4. Create audit log for school creation
    await createAuditLog(req, 'CREATE', 'SCHOOL', school.id, null, school);

    // 5. Create audit log for features seeding
    if (seededFeatures.length > 0) {
      await createAuditLog(req, 'SEED', 'FEATURES', null, null, { 
        schoolId: school.id, 
        schoolName: school.name,
        featuresSeeded: seededFeatures.length 
      });
    }

    // 6. Return success response with seeding info
    res.status(201).json({ 
      success: true, 
      school,
      seeding: {
        featuresSeeded: seededFeatures.length,
        message: `School created successfully with ${seededFeatures.length} features`
      }
    });

    console.log(`✅ School created and auto-seeded: ${school.name} (${seededFeatures.length} features)`);

  } catch (error) {
    console.error('❌ Create school error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.get('/api/schools', authenticate, async (req, res) => {
  try {
    let schools;
    
    if (req.user.role === 'SUPER_ADMIN') {
      schools = await School.findAll({
        include: [{ model: User, as: 'Users' }]
      });
    } else {
      schools = await School.findAll({
        where: { id: req.user.schoolId },
        include: [{ model: User, as: 'Users' }]
      });
    }
    
    res.json({ success: true, schools });
  } catch (error) {
    console.error('Get schools error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/schools/:id', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id, {
      include: [
        { model: Class },
        { model: Student },
        { model: Subject },
        { model: User }
      ]
    });
    
    if (!school) return res.status(404).json({ message: 'School not found' });
    
    res.json({ success: true, school });
  } catch (error) {
    console.error('Get school error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/schools/:id', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ message: 'School not found' });

    if (req.user.role !== 'SUPER_ADMIN' && req.user.schoolId !== school.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const oldSchool = { ...school.toJSON() };
    await school.update(req.body);
    await createAuditLog(req, 'UPDATE', 'SCHOOL', school.id, oldSchool, school);

    res.json({ success: true, school });
  } catch (error) {
    console.error('Update school error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/schools/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) {
      return res.status(404).json({ message: 'School not found' });
    }

    await school.destroy();
    await createAuditLog(req, 'DELETE', 'SCHOOL', req.params.id);

    res.json({
      success: true,
      message: 'School deleted successfully'
    });
  } catch (error) {
    console.error('Delete school error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== USER ROUTES ====================

app.get('/api/users', authenticate, async (req, res) => {
  try {
    const where = {};
    if (req.user.role !== 'SUPER_ADMIN') where.schoolId = req.user.schoolId;

    const users = await User.findAll({
      where,
      attributes: { exclude: ['password'] },
      include: [{ model: School }]
    });
    
    res.json({ success: true, users });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/users/:id', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id, {
      attributes: { exclude: ['password'] },
      include: [{ model: School }, { model: Staff }]
    });
    
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (req.user.role !== 'SUPER_ADMIN' && user.schoolId !== req.user.schoolId) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    res.json({ success: true, user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/users', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone, role, schoolId } = req.body;

    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) return res.status(400).json({ message: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password || 'Password123!', 10);
    const user = await User.create({
      email,
      password: hashedPassword,
      firstName,
      lastName,
      phone,
      role,
      schoolId: schoolId || req.user.schoolId
    });

    user.password = undefined;
    await createAuditLog(req, 'CREATE', 'USER', user.id, null, user);

    res.status(201).json({ success: true, user });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/users/:id', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (req.user.role !== 'SUPER_ADMIN' && user.schoolId !== req.user.schoolId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const oldUser = { ...user.toJSON() };
    await user.update(req.body);
    await createAuditLog(req, 'UPDATE', 'USER', user.id, oldUser, user);

    res.json({ success: true, user });
  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/users/:id', authenticate, async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (req.user.role !== 'SUPER_ADMIN' && user.schoolId !== req.user.schoolId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await user.destroy();
    await createAuditLog(req, 'DELETE', 'USER', req.params.id);

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== CLASS ROUTES ====================

app.post('/api/classes', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, capacity, streams, academicYear } = req.body;

    let schoolId = req.user.schoolId;
    
    if (!schoolId && req.body.schoolId) {
      schoolId = req.body.schoolId;
    }
    
    if (!schoolId) {
      return res.status(400).json({ 
        message: 'School ID is required. You must be associated with a school or provide schoolId.' 
      });
    }

    const classObj = await Class.create({
      name,
      capacity,
      streams,
      academicYear,
      schoolId: schoolId
    });

    await createAuditLog(req, 'CREATE', 'CLASS', classObj.id, null, classObj);

    res.status(201).json({ success: true, class: classObj });
  } catch (error) {
    console.error('Create class error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/classes', authenticate, async (req, res) => {
  try {
    let where = {};
    
    if (req.user.schoolId) {
      where.schoolId = req.user.schoolId;
    }
    
    const classes = await Class.findAll({
      where,
      include: [
        { model: Student, required: false },
        { model: Subject, required: false },
        { model: User, as: 'classTeacher', attributes: ['firstName', 'lastName'], required: false }
      ]
    });
    
    res.json({ success: true, classes });
  } catch (error) {
    console.error('Get classes error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/classes/:id', authenticate, async (req, res) => {
  try {
    const classObj = await Class.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId },
      include: [
        { model: Student, required: false },
        { model: Subject, required: false },
        { model: User, as: 'classTeacher', attributes: ['firstName', 'lastName'], required: false }
      ]
    });
    
    if (!classObj) return res.status(404).json({ message: 'Class not found' });
    
    res.json({ success: true, class: classObj });
  } catch (error) {
    console.error('Get class error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/classes/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const classObj = await Class.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!classObj) return res.status(404).json({ message: 'Class not found' });

    const oldClass = { ...classObj.toJSON() };
    await classObj.update(req.body);
    await createAuditLog(req, 'UPDATE', 'CLASS', classObj.id, oldClass, classObj);

    res.json({ success: true, class: classObj });
  } catch (error) {
    console.error('Update class error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/classes/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const classObj = await Class.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!classObj) return res.status(404).json({ message: 'Class not found' });

    await classObj.destroy();
    await createAuditLog(req, 'DELETE', 'CLASS', req.params.id);

    res.json({ success: true, message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Delete class error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== COMPLETE BACKEND WITH OPTION 2 (ADMISSION NUMBER BASED) ====================

// ==================== STUDENT ROUTES ====================

// POST create a new student
app.post('/api/students', authenticate, async (req, res) => {
  try {
    const studentData = { ...req.body };
    
    const school = await School.findByPk(req.user.schoolId);
    if (!school) return res.status(404).json({ message: 'School not found' });

    const uuidFields = ['classId', 'courseId', 'programId', 'facultyId', 'departmentId', 'transportRouteId'];
    uuidFields.forEach(field => {
      if (studentData[field] === '') studentData[field] = null;
    });

    if (school.category === 'UNIVERSITY') {
      if (!studentData.courseId) {
        return res.status(400).json({ message: 'Course ID is required for university students' });
      }
      if (!studentData.currentYear) studentData.currentYear = 1;
      if (!studentData.currentSemester) studentData.currentSemester = 1;
    } else if (school.category === 'COLLEGE_TVET') {
      if (!studentData.programId) {
        return res.status(400).json({ message: 'Program ID is required for TVET students' });
      }
      if (!studentData.currentModule) studentData.currentModule = 'Module 1';
    } else {
      if (!studentData.classId) {
        return res.status(400).json({ message: 'Class ID is required' });
      }
    }

    let admissionNumber = studentData.admissionNumber;
    if (!admissionNumber) {
      admissionNumber = await generateAdmissionNumber(req.user.schoolId);
    } else {
      const existingStudent = await Student.findOne({
        where: { admissionNumber, schoolId: req.user.schoolId }
      });
      if (existingStudent) {
        return res.status(400).json({ 
          message: `Admission number '${admissionNumber}' already exists.` 
        });
      }
    }

    const student = await Student.create({
      ...studentData,
      admissionNumber,
      schoolId: req.user.schoolId,
      enrollmentDate: studentData.enrollmentDate || new Date(),
    });

    await createAuditLog(req, 'CREATE', 'STUDENT', student.id, null, student);
    res.status(201).json({ success: true, student });
  } catch (error) {
    console.error('Create student error:', error);
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ message: 'Admission number already exists' });
    }
    res.status(500).json({ message: error.message });
  }
});
// ==================== STUDENTS ROUTES ====================

// GET all students (with role-based filtering)
app.get('/api/students', authenticate, async (req, res) => {
  try {
    const { classId, courseId, programId, search } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Apply filters based on school type
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      if (programId) where.programId = programId;
    } else {
      if (classId) where.classId = classId;
    }
    
    if (search) {
      where[Op.or] = [
        { firstName: { [Op.iLike]: `%${search}%` } },
        { lastName: { [Op.iLike]: `%${search}%` } },
        { admissionNumber: { [Op.iLike]: `%${search}%` } }
      ];
    }

    // Role-based access
    if (req.user.role === 'STUDENT') {
      // Students can only see their own record
      where.userId = req.user.id;
    } else if (req.user.role === 'PARENT') {
      const parentRecords = await Parent.findAll({ 
        where: { userId: req.user.id }, 
        attributes: ['studentId'] 
      });
      const studentIds = parentRecords.map(p => p.studentId);
      where.id = studentIds;
    }

    const include = [
      { model: Parent, include: [{ model: User }], required: false },
      { model: TransportRoute, required: false }
    ];
    
    // Add course/program/class based on school type
    if (school.category === 'UNIVERSITY') {
      include.push({ 
        model: Course, 
        required: false,
        attributes: ['id', 'name', 'code']
      });
    } else if (school.category === 'COLLEGE_TVET') {
      include.push({ 
        model: Program, 
        required: false,
        attributes: ['id', 'name', 'code']
      });
    } else {
      include.push({ 
        model: Class, 
        required: false,
        attributes: ['id', 'name', 'stream']
      });
    }

    const students = await Student.findAll({
      where,
      include,
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, students });
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== STUDENT SELF-SERVICE ENDPOINTS ====================

// GET current student's own data (for logged-in students)
app.get('/api/students/me', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'STUDENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for students' 
      });
    }

    // Find student by userId
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        userId: req.user.id
      },
      include: [
        { 
          model: Class, 
          required: false,
          attributes: ['id', 'name']
        },
        { 
          model: Course, 
          required: false,
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Program, 
          required: false,
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Parent, 
          include: [{ model: User }], 
          required: false 
        }
      ]
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student record not found for your account' 
      });
    }

    res.json({ success: true, student });
  } catch (error) {
    console.error('Get current student error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET student by admission number (for students to look up themselves)
app.get('/api/students/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const upperAdmission = admissionNumber.toUpperCase();
    
    console.log(`🔍 Fetching student by admission: ${upperAdmission}, Role: ${req.user.role}`);
    
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber: upperAdmission
      },
      include: [
        { 
          model: Class, 
          required: false,
          attributes: ['id', 'name']
        },
        { 
          model: Course, 
          required: false,
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Program, 
          required: false,
          attributes: ['id', 'name', 'code']
        }
      ]
    });

    if (!student) {
      console.log(`❌ Student not found with admission: ${upperAdmission}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    // Verify access permissions
    if (req.user.role === 'STUDENT') {
      // Students can only see their own record
      if (student.userId !== req.user.id) {
        console.log(`❌ Student ${req.user.id} trying to access student ${student.id} - Access denied`);
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    } else if (req.user.role === 'PARENT') {
      // Parents can see their children's records
      const parent = await Parent.findOne({ 
        where: { userId: req.user.id, studentId: student.id } 
      });
      if (!parent) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    }

    console.log(`✅ Found student: ${student.firstName} ${student.lastName}`);
    res.json({ success: true, student });
  } catch (error) {
    console.error('Get student by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET student by user ID
app.get('/api/students/by-user/:userId', authenticate, async (req, res) => {
  try {
    const { userId } = req.params;
    
    console.log(`🔍 Backend: Fetching student for user: ${userId}, Role: ${req.user.role}`);
    
    // Check permissions
    if (req.user.role === 'STUDENT' && req.user.id !== userId) {
      console.log(`❌ Student ${req.user.id} trying to access student for user ${userId} - Access denied`);
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }
    
    if (req.user.role === 'PARENT') {
      // Verify parent has access to this student
      const student = await Student.findOne({ where: { userId } });
      if (student) {
        const parent = await Parent.findOne({ 
          where: { userId: req.user.id, studentId: student.id } 
        });
        if (!parent) {
          return res.status(403).json({ 
            success: false, 
            message: 'Access denied' 
          });
        }
      }
    }

    // Find the student linked to this user
    const student = await Student.findOne({
      where: { 
        userId: userId,
        schoolId: req.user.schoolId 
      },
      include: [
        { 
          model: Class, 
          required: false,
          attributes: ['id', 'name'] 
        },
        { 
          model: Course, 
          required: false,
          attributes: ['id', 'name', 'code'] 
        },
        { 
          model: Program, 
          required: false,
          attributes: ['id', 'name', 'code'] 
        }
      ]
    });

    if (!student) {
      console.log(`❌ No student record found for user: ${userId}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Student record not found for this user' 
      });
    }

    console.log(`✅ Found student: ${student.firstName} ${student.lastName}`);
    res.json({ 
      success: true, 
      student 
    });
  } catch (error) {
    console.error('❌ Get student by user error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET single student by ID
app.get('/api/students/:id', authenticate, async (req, res) => {
  try {
    const studentId = req.params.id;

    // Check permissions
    if (req.user.role === 'STUDENT') {
      // Students can only see their own record
      const studentCheck = await Student.findOne({ 
        where: { id: studentId, userId: req.user.id } 
      });
      if (!studentCheck) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    }

    const school = await School.findByPk(req.user.schoolId);
    const include = [
      { model: Parent, include: [{ model: User }], required: false },
      { model: Result, include: [{ model: Exam }], required: false },
      { model: Attendance, required: false },
      { model: Payment, required: false },
      { model: TransportRoute, required: false }
    ];

    if (school.category === 'UNIVERSITY') {
      include.push({ model: Course, required: false });
    } else if (school.category === 'COLLEGE_TVET') {
      include.push({ model: Program, required: false });
    } else {
      include.push({ model: Class, required: false });
    }

    const student = await Student.findOne({
      where: { id: studentId, schoolId: req.user.schoolId },
      include
    });
    
    if (!student) return res.status(404).json({ message: 'Student not found' });
    
    res.json({ success: true, student });
  } catch (error) {
    console.error('Get student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// CREATE student
app.post('/api/students', authenticate, async (req, res) => {
  try {
    const studentData = req.body;
    
    // Only admins can create students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Generate admission number if not provided
    if (!studentData.admissionNumber) {
      const year = new Date().getFullYear();
      const count = await Student.count({ where: { schoolId: req.user.schoolId } }) + 1;
      studentData.admissionNumber = `${year}-${count.toString().padStart(4, '0')}`;
    }
    
    // Ensure schoolId is set
    studentData.schoolId = req.user.schoolId;
    
    const student = await Student.create(studentData);
    
    // If a user account should be created
    if (studentData.studentLogin?.createAccount && studentData.studentLogin.email) {
      const user = await User.create({
        email: studentData.studentLogin.email,
        password: studentData.studentLogin.password,
        firstName: studentData.firstName,
        lastName: studentData.lastName,
        role: 'STUDENT',
        schoolId: req.user.schoolId,
        phone: studentData.phone
      });
      
      // Link the student to the user
      await student.update({ userId: user.id });
    }
    
    res.json({ success: true, student });
    
  } catch (error) {
    console.error('Create student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// UPDATE student
app.put('/api/students/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    const student = await Student.findByPk(id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    // Check permissions
    if (req.user.role === 'STUDENT' && student.userId !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await student.update(req.body);
    
    res.json({ success: true, student });
    
  } catch (error) {
    console.error('Update student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// DELETE student
app.delete('/api/students/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Only admins can delete students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const student = await Student.findByPk(id);
    if (!student) {
      return res.status(404).json({ message: 'Student not found' });
    }
    
    await student.destroy();
    
    res.json({ success: true, message: 'Student deleted successfully' });
    
  } catch (error) {
    console.error('Delete student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== STUDENT PROGRESSION ENDPOINTS ====================

// Progress students to next year/semester (University)
app.post('/api/students/progress', authenticate, async (req, res) => {
  try {
    const { studentIds, newYear, newSemester } = req.body;
    
    if (!studentIds || !newYear) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    
    // Only admins can progress students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await Student.update(
      { currentYear: newYear, currentSemester: newSemester || 1 },
      { where: { id: studentIds, schoolId: req.user.schoolId } }
    );
    
    res.json({ success: true, message: `${studentIds.length} students progressed` });
    
  } catch (error) {
    console.error('Progress students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Progress TVET students to next module
app.post('/api/students/progress-module', authenticate, async (req, res) => {
  try {
    const { studentIds, newModule, newYear } = req.body;
    
    // Only admins can progress students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const updateData = { currentModule: newModule };
    if (newYear) updateData.currentYear = newYear;
    
    await Student.update(updateData, { where: { id: studentIds, schoolId: req.user.schoolId } });
    
    res.json({ success: true, message: `${studentIds.length} students progressed to ${newModule}` });
    
  } catch (error) {
    console.error('Progress module error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Progress TVET students to new program
app.post('/api/students/progress-program', authenticate, async (req, res) => {
  try {
    const { studentIds, newProgramId, newYear } = req.body;
    
    // Only admins can progress students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    const updateData = { 
      programId: newProgramId,
      currentModule: 'Module 1'
    };
    if (newYear) updateData.currentYear = newYear;
    
    await Student.update(updateData, { where: { id: studentIds, schoolId: req.user.schoolId } });
    
    res.json({ success: true, message: `${studentIds.length} students progressed to new program` });
    
  } catch (error) {
    console.error('Progress program error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Progress TVET students to next year
app.post('/api/students/progress-year', authenticate, async (req, res) => {
  try {
    const { studentIds, newYear } = req.body;
    
    // Only admins can progress students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await Student.update(
      { currentYear: newYear },
      { where: { id: studentIds, schoolId: req.user.schoolId } }
    );
    
    res.json({ success: true, message: `${studentIds.length} students progressed to Year ${newYear}` });
    
  } catch (error) {
    console.error('Progress year error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Promote regular school students to next class
app.post('/api/students/promote', authenticate, async (req, res) => {
  try {
    const { studentIds, newClassId, academicYear } = req.body;
    
    // Only admins can promote students
    if (!['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    await Student.update(
      { classId: newClassId },
      { where: { id: studentIds, schoolId: req.user.schoolId } }
    );
    
    res.json({ success: true, message: `${studentIds.length} students promoted to new class` });
    
  } catch (error) {
    console.error('Promote students error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});
// ==================== SPECIALIZED ATTENDANCE ENDPOINTS ====================

// GET attendance by admission number
app.get('/api/attendance/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { startDate, endDate, limit = 50 } = req.query;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const where = { studentId: student.id };
    
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    const attendance = await Attendance.findAll({
      where,
      include: [
        { 
          model: Course, 
          attributes: ['id', 'name', 'code'],
          required: false 
        },
        { 
          model: Class, 
          attributes: ['id', 'name'],
          required: false 
        }
      ],
      order: [['date', 'DESC']],
      limit: parseInt(limit)
    });

    // Calculate summary
    const summary = {
      total: attendance.length,
      present: attendance.filter(a => a.status === 'PRESENT').length,
      absent: attendance.filter(a => a.status === 'ABSENT').length,
      late: attendance.filter(a => a.status === 'LATE').length,
      permission: attendance.filter(a => a.status === 'PERMISSION').length,
      sick: attendance.filter(a => a.status === 'SICK').length,
      presentPercentage: attendance.length > 0 
        ? ((attendance.filter(a => a.status === 'PRESENT').length / attendance.length) * 100).toFixed(2)
        : 0
    };

    res.json({ 
      success: true, 
      attendance,
      summary,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get attendance by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== SPECIALIZED FEE ENDPOINTS ====================

// GET fee statement by admission number
app.get('/api/fees/by-admission/:admissionNumber/statement', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      feeWhere.courseId = student.courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      feeWhere.programId = student.programId;
    } else {
      feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });

    const payments = await Payment.findAll({
      where: { studentId: student.id },
      include: [{ model: Fee }],
      order: [['date', 'DESC']]
    });

    const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = totalFees - totalPaid;

    res.json({
      success: true,
      statement: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          admissionNumber: student.admissionNumber
        },
        fees,
        payments,
        summary: {
          totalFees,
          totalPaid,
          balance
        }
      }
    });
  } catch (error) {
    console.error('Get fee statement by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== SPECIALIZED EXAM CARD ENDPOINTS ====================
// ==================== GET COURSE UNITS BY PROGRAM ID (FOR TVET) ====================
app.get('/api/course-units/by-program/:programId', authenticate, async (req, res) => {
  try {
    const { programId } = req.params;
    const { year, module } = req.query;
    
    console.log(`📚 Fetching course units for program: ${programId}`);
    
    const where = { 
      programId,
      schoolId: req.user.schoolId 
    };
    
    // Filter by year if provided
    if (year && !isNaN(parseInt(year))) {
      where.year = parseInt(year);
    }
    
    // Filter by module if provided
    if (module && !isNaN(parseInt(module))) {
      where.module = parseInt(module);
    }
    
    const units = await CourseUnit.findAll({
      where,
      order: [['module', 'ASC'], ['year', 'ASC'], ['name', 'ASC']]
    });
    
    console.log(`✅ Found ${units.length} units for program ${programId}`);
    
    res.json({ 
      success: true, 
      units,
      count: units.length
    });
  } catch (error) {
    console.error('❌ Get course units by program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ==================== GET COURSE UNITS BY COURSE ID (FOR UNIVERSITY) ====================
app.get('/api/course-units/by-course/:courseId', authenticate, async (req, res) => {
  try {
    const { courseId } = req.params;
    const { year, semester } = req.query;
    
    console.log(`📚 Fetching course units for course: ${courseId}`);
    
    const where = { 
      courseId,
      schoolId: req.user.schoolId 
    };
    
    // Filter by year if provided
    if (year && !isNaN(parseInt(year))) {
      where.year = parseInt(year);
    }
    
    // Filter by semester if provided
    if (semester && !isNaN(parseInt(semester))) {
      where.semester = parseInt(semester);
    }
    
    const units = await CourseUnit.findAll({
      where,
      order: [['semester', 'ASC'], ['year', 'ASC'], ['name', 'ASC']]
    });
    
    console.log(`✅ Found ${units.length} units for course ${courseId}`);
    
    res.json({ 
      success: true, 
      units,
      count: units.length
    });
  } catch (error) {
    console.error('❌ Get course units by course error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// GET exam card by admission number (with full TVET support)
app.get('/api/exam-cards/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { semester, module, year } = req.query;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { model: Course, as: 'course', attributes: ['id', 'name', 'code'] },
        { model: Program, as: 'program', attributes: ['id', 'name', 'code', 'level'] },
        { model: Class, as: 'class', attributes: ['id', 'name'] }
      ]
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    if (!school) {
      return res.status(404).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    console.log('📘 Student found:', {
      id: student.id,
      name: `${student.firstName} ${student.lastName}`,
      admission: student.admissionNumber,
      schoolCategory: school.category,
      courseId: student.courseId,
      programId: student.programId,
      classId: student.classId
    });

    // ==================== GET APPLICABLE FEES ====================
    let feeWhere = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY') {
      if (student.courseId) {
        feeWhere.courseId = student.courseId;
      }
      if (year || student.currentYear) {
        feeWhere.year = year || student.currentYear;
      }
      if (semester) {
        feeWhere.semester = parseInt(semester);
      } else if (student.currentSemester) {
        feeWhere.semester = student.currentSemester;
      }
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (student.programId) {
        feeWhere.programId = student.programId;
      }
      if (year || student.currentYear) {
        feeWhere.year = year || student.currentYear;
      }
      if (module) {
        feeWhere.module = parseInt(module);
      } else if (student.currentModule) {
        const moduleNum = parseInt(student.currentModule.replace(/\D/g, ''));
        if (!isNaN(moduleNum)) {
          feeWhere.module = moduleNum;
        }
      }
    } 
    else {
      // Secondary/Primary
      if (student.classId) {
        feeWhere.classId = student.classId;
      }
    }

    const fees = await Fee.findAll({ where: feeWhere });
    const totalFees = fees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);

    // ==================== GET PAYMENTS ====================
    const payments = await Payment.findAll({ 
      where: { studentId: student.id },
      order: [['paymentDate', 'DESC']]
    });
    
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const balance = totalFees - totalPaid;
    const isEligible = balance <= 0;

    // ==================== GET UNITS/SUBJECTS ====================
    let units = [];
    
    if (school.category === 'UNIVERSITY') {
      const unitWhere = { 
        schoolId: req.user.schoolId, 
        courseId: student.courseId,
        isActive: true
      };
      
      if (semester) {
        unitWhere.semester = parseInt(semester);
      } else if (student.currentSemester) {
        unitWhere.semester = student.currentSemester;
      }
      
      if (year || student.currentYear) {
        unitWhere.year = year || student.currentYear;
      }
      
      units = await CourseUnit.findAll({ 
        where: unitWhere,
        order: [['semester', 'ASC'], ['name', 'ASC']]
      });
      
      console.log(`📚 Found ${units.length} units for course ${student.courseId}`);
    } 
    else if (school.category === 'COLLEGE_TVET') {
      const unitWhere = { 
        schoolId: req.user.schoolId, 
        programId: student.programId,
        isActive: true
      };
      
      // Filter by module
      let moduleNum = null;
      if (module) {
        moduleNum = parseInt(module);
      } else if (student.currentModule) {
        moduleNum = parseInt(student.currentModule.replace(/\D/g, ''));
      }
      
      if (moduleNum && !isNaN(moduleNum)) {
        unitWhere.module = moduleNum;
      }
      
      if (year || student.currentYear) {
        unitWhere.year = year || student.currentYear;
      }
      
      units = await CourseUnit.findAll({ 
        where: unitWhere,
        order: [['module', 'ASC'], ['name', 'ASC']]
      });
      
      console.log(`📚 Found ${units.length} modules for program ${student.programId} (Module: ${moduleNum || 'all'})`);
    } 
    else {
      // Secondary/Primary - get subjects
      const subjectWhere = { 
        schoolId: req.user.schoolId, 
        classId: student.classId,
        isActive: true
      };
      
      units = await Subject.findAll({ 
        where: subjectWhere,
        order: [['name', 'ASC']]
      });
      
      console.log(`📚 Found ${units.length} subjects for class ${student.classId}`);
    }

    // ==================== BUILD RESPONSE ====================
    // Get program/course/class name
    let programName = null;
    let courseName = null;
    let className = null;
    
    if (school.category === 'UNIVERSITY') {
      if (student.course) {
        courseName = student.course.name;
      } else if (student.courseId) {
        const course = await Course.findByPk(student.courseId);
        courseName = course?.name || null;
      }
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (student.program) {
        programName = student.program.name;
      } else if (student.programId) {
        const program = await Program.findByPk(student.programId);
        programName = program?.name || null;
      }
    } 
    else {
      if (student.class) {
        className = student.class.name;
      } else if (student.classId) {
        const classObj = await Class.findByPk(student.classId);
        className = classObj?.name || null;
      }
    }

    // Get module display
    let moduleDisplay = null;
    if (school.category === 'COLLEGE_TVET') {
      if (student.currentModule) {
        moduleDisplay = student.currentModule;
      } else if (student.module) {
        moduleDisplay = student.module;
      } else {
        moduleDisplay = 'Module 1';
      }
    }

    res.json({
      success: true,
      examCard: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          middleName: student.middleName,
          admissionNumber: student.admissionNumber,
          courseId: student.courseId,
          courseName: courseName,
          programId: student.programId,
          programName: programName,
          classId: student.classId,
          className: className,
          currentYear: student.currentYear,
          currentSemester: student.currentSemester,
          currentModule: moduleDisplay,
          module: moduleDisplay
        },
        school: {
          id: school.id,
          name: school.name,
          motto: school.motto,
          category: school.category,
          contact: school.contact,
          hod: school.hod || (school.category === 'COLLEGE_TVET' ? 'Head of Department' : null)
        },
        fees: {
          total: totalFees,
          paid: totalPaid,
          balance: balance,
          isEligible: isEligible,
          structure: fees.map(f => ({
            id: f.id,
            name: f.name,
            amount: f.amount,
            category: f.category
          }))
        },
        units: units.map(u => ({
          id: u.id,
          name: u.name,
          code: u.code,
          semester: u.semester,
          module: u.module,
          year: u.year,
          credits: u.credits,
          description: u.description
        })),
        payments: payments.map(p => ({
          id: p.id,
          amount: p.amount,
          paymentMethod: p.paymentMethod,
          receiptNumber: p.receiptNumber,
          paymentDate: p.paymentDate,
          transactionId: p.transactionId,
          notes: p.notes
        })),
        generatedAt: new Date()
      }
    });
    
  } catch (error) {
    console.error('Get exam card by admission error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// GET exam cards for zero balance students (teacher/admin view)
app.get('/api/exam-cards/zero-balance-students', authenticate, async (req, res) => {
  try {
    const { 
      classId, courseId, programId, 
      year, semester, module, 
      startDate, endDate 
    } = req.query;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (!school) {
      return res.status(404).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    // ==================== GET STUDENTS BASED ON FILTERS ====================
    let studentWhere = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY' && courseId) {
      studentWhere.courseId = courseId;
      if (year) studentWhere.currentYear = parseInt(year);
    } 
    else if (school.category === 'COLLEGE_TVET' && programId) {
      studentWhere.programId = programId;
      if (year) studentWhere.currentYear = parseInt(year);
      if (module) {
        studentWhere.currentModule = `Module ${module}`;
      }
    } 
    else if (classId) {
      studentWhere.classId = classId;
    }
    
    const students = await Student.findAll({ 
      where: studentWhere,
      include: [
        { model: Course, as: 'course', attributes: ['id', 'name'] },
        { model: Program, as: 'program', attributes: ['id', 'name'] },
        { model: Class, as: 'class', attributes: ['id', 'name'] }
      ]
    });
    
    if (students.length === 0) {
      return res.json({ 
        success: true, 
        students: [] 
      });
    }

    // ==================== GET FEE STRUCTURE ====================
    let feeWhere = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY' && courseId) {
      feeWhere.courseId = courseId;
      if (year) feeWhere.year = parseInt(year);
      if (semester) feeWhere.semester = parseInt(semester);
    } 
    else if (school.category === 'COLLEGE_TVET' && programId) {
      feeWhere.programId = programId;
      if (year) feeWhere.year = parseInt(year);
      if (module) feeWhere.module = parseInt(module);
    } 
    else if (classId) {
      feeWhere.classId = classId;
    }
    
    const fees = await Fee.findAll({ where: feeWhere });
    const totalFeesAmount = fees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);

    // ==================== GET UNITS/SUBJECTS FOR EACH STUDENT ====================
    const studentsWithData = await Promise.all(students.map(async (student) => {
      // Get payments
      const payments = await Payment.findAll({ 
        where: { studentId: student.id }
      });
      const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      const balance = totalFeesAmount - totalPaid;
      const isEligible = balance <= 0;
      
      // Get units/subjects
      let units = [];
      if (school.category === 'UNIVERSITY') {
        const unitWhere = { 
          schoolId: req.user.schoolId, 
          courseId: student.courseId,
          isActive: true
        };
        if (semester) unitWhere.semester = parseInt(semester);
        if (year) unitWhere.year = parseInt(year);
        units = await CourseUnit.findAll({ where: unitWhere });
      } 
      else if (school.category === 'COLLEGE_TVET') {
        const unitWhere = { 
          schoolId: req.user.schoolId, 
          programId: student.programId,
          isActive: true
        };
        if (module) unitWhere.module = parseInt(module);
        if (year) unitWhere.year = parseInt(year);
        units = await CourseUnit.findAll({ where: unitWhere });
      } 
      else {
        const unitWhere = { 
          schoolId: req.user.schoolId, 
          classId: student.classId,
          isActive: true
        };
        units = await Subject.findAll({ where: unitWhere });
      }
      
      // Get program/course/class name
      let entityName = '';
      if (school.category === 'UNIVERSITY') {
        entityName = student.course?.name || '';
      } else if (school.category === 'COLLEGE_TVET') {
        entityName = student.program?.name || '';
      } else {
        entityName = student.class?.name || '';
      }
      
      return {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber,
        courseId: student.courseId,
        programId: student.programId,
        classId: student.classId,
        entityName: entityName,
        currentYear: student.currentYear,
        currentSemester: student.currentSemester,
        currentModule: student.currentModule,
        totalFees: totalFeesAmount,
        totalPaid: totalPaid,
        balance: balance,
        isEligible: isEligible,
        units: units.map(u => ({
          id: u.id,
          name: u.name,
          code: u.code,
          semester: u.semester,
          module: u.module
        }))
      };
    }));
    
    // Filter to only eligible students (zero balance)
    const eligibleStudents = studentsWithData.filter(s => s.isEligible);
    
    res.json({
      success: true,
      totalStudents: students.length,
      eligibleCount: eligibleStudents.length,
      students: eligibleStudents,
      filters: {
        schoolCategory: school.category,
        classId,
        courseId,
        programId,
        year,
        semester,
        module
      }
    });
    
  } catch (error) {
    console.error('Get zero balance students error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// GET student fee statement by admission number
app.get('/api/fee-statement/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { startDate, endDate } = req.query;
    
    // Find student
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { model: Course, as: 'course', attributes: ['id', 'name'] },
        { model: Program, as: 'program', attributes: ['id', 'name'] },
        { model: Class, as: 'class', attributes: ['id', 'name'] }
      ]
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Get fee structure
    let feeWhere = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY') {
      if (student.courseId) feeWhere.courseId = student.courseId;
      if (student.currentYear) feeWhere.year = student.currentYear;
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (student.programId) feeWhere.programId = student.programId;
    } 
    else {
      if (student.classId) feeWhere.classId = student.classId;
    }
    
    const fees = await Fee.findAll({ where: feeWhere });
    
    // Get payments
    let paymentWhere = { studentId: student.id };
    if (startDate && endDate) {
      paymentWhere.paymentDate = { [Op.between]: [startDate, endDate] };
    }
    
    const payments = await Payment.findAll({ 
      where: paymentWhere,
      order: [['paymentDate', 'DESC']]
    });
    
    const totalFees = fees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const balance = totalFees - totalPaid;
    
    res.json({
      success: true,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber,
        courseName: student.course?.name,
        programName: student.program?.name,
        className: student.class?.name
      },
      school: {
        name: school.name,
        motto: school.motto,
        contact: school.contact
      },
      feeStructure: fees,
      payments: payments,
      totalFees,
      totalPaid,
      balance,
      isCleared: balance <= 0
    });
    
  } catch (error) {
    console.error('Get fee statement error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// GET student details by admission number (for exam card)
app.get('/api/students/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { 
          model: Course, 
          as: 'course',
          attributes: ['id', 'name', 'code'],
          include: [{ model: Department, as: 'department', attributes: ['id', 'name'] }]
        },
        { 
          model: Program, 
          as: 'program',
          attributes: ['id', 'name', 'code', 'level']
        },
        { 
          model: Class, 
          as: 'class',
          attributes: ['id', 'name']
        }
      ]
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }
    
    res.json({
      success: true,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        middleName: student.middleName,
        admissionNumber: student.admissionNumber,
        email: student.email,
        phone: student.phone,
        dateOfBirth: student.dateOfBirth,
        gender: student.gender,
        courseId: student.courseId,
        course: student.course,
        programId: student.programId,
        program: student.program,
        classId: student.classId,
        class: student.class,
        currentYear: student.currentYear,
        currentSemester: student.currentSemester,
        currentModule: student.currentModule,
        boardingStatus: student.boardingStatus,
        isActive: student.isActive,
        medicalInfo: student.medicalInfo
      }
    });
    
  } catch (error) {
    console.error('Get student by admission error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});
// ==================== SPECIALIZED LIBRARY ENDPOINTS ====================

// GET borrowed books by admission number
app.get('/api/library/by-admission/:admissionNumber/borrowed', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const borrows = await Borrow.findAll({
      where: { 
        studentId: student.id,
        status: 'BORROWED'
      },
      include: [
        { model: Book, required: false }
      ],
      order: [['dueDate', 'ASC']]
    });

    res.json({ 
      success: true, 
      borrows,
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get borrowed books by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET available books (public, no admission needed)
app.get('/api/library/available', authenticate, async (req, res) => {
  try {
    const { search, category } = req.query;
    const where = { 
      schoolId: req.user.schoolId,
      available: { [Op.gt]: 0 }
    };

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { author: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (category) where.category = category;

    const books = await Book.findAll({ 
      where,
      order: [['title', 'ASC']]
    });

    res.json({ success: true, books });
  } catch (error) {
    console.error('Get available books error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== SPECIALIZED TIMETABLE ENDPOINTS ====================

// GET timetable by admission number
app.get('/api/timetable/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    let where = { schoolId: req.user.schoolId };
    
    if (school.category === 'UNIVERSITY') {
      where.courseId = student.courseId;
      if (student.currentYear) where.year = student.currentYear;
      if (student.currentSemester) where.semester = student.currentSemester;
    } else {
      where.classId = student.classId;
    }

    const timetable = await Timetable.findAll({
      where,
      include: [
        { model: Subject, required: false },
        { model: CourseUnit, as: 'unit', required: false },
        { 
          model: Staff, 
          as: 'teacher',
          include: [{ model: User, attributes: ['firstName', 'lastName'] }],
          required: false 
        }
      ],
      order: [['day', 'ASC'], ['period', 'ASC']]
    });

    res.json({ 
      success: true, 
      timetable,
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get timetable by admission error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== PARENT-SPECIFIC ENDPOINTS ====================

// GET parent's children
app.get('/api/parents/me/children', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const parents = await Parent.findAll({
      where: { userId: req.user.id },
      include: [{
        model: Student,
        include: [
          { model: Class, required: false },
          { model: Course, required: false }
        ]
      }]
    });

    const children = parents.map(p => p.Student).filter(s => s);

    res.json({ 
      success: true, 
      children,
      count: children.length
    });
  } catch (error) {
    console.error('Get parent children error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's results by admission number
app.get('/api/parents/me/children/:admissionNumber/results', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;

    // Find the student
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    // Verify this parent has access to this student
    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const results = await Result.findAll({
      where: { studentId: student.id },
      include: [
        { model: Exam, attributes: ['id', 'name', 'date', 'type'] },
        { model: Subject, attributes: ['id', 'name'] },
        { model: CourseUnit, as: 'CourseUnit', attributes: ['id', 'name'] }
      ],
      order: [['createdAt', 'DESC']]
    });

    res.json({ 
      success: true, 
      results,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get child results error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's attendance by admission number
app.get('/api/parents/me/children/:admissionNumber/attendance', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;
    const { startDate, endDate } = req.query;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const where = { studentId: student.id };
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    const attendance = await Attendance.findAll({
      where,
      include: [
        { model: Course, attributes: ['id', 'name'] },
        { model: Class, attributes: ['id', 'name'] }
      ],
      order: [['date', 'DESC']]
    });

    res.json({ 
      success: true, 
      attendance,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get child attendance error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's fee statement by admission number
app.get('/api/parents/me/children/:admissionNumber/fees', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      feeWhere.courseId = student.courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      feeWhere.programId = student.programId;
    } else {
      feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });
    const payments = await Payment.findAll({ 
      where: { studentId: student.id },
      order: [['date', 'DESC']]
    });

    const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    res.json({
      success: true,
      statement: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          admissionNumber: student.admissionNumber
        },
        fees,
        payments,
        summary: {
          totalFees,
          totalPaid,
          balance: totalFees - totalPaid
        }
      }
    });
  } catch (error) {
    console.error('Get child fees error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's exam card by admission number
app.get('/api/parents/me/children/:admissionNumber/exam-card', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;
    const { semester } = req.query;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);

    // Get applicable fees
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      feeWhere.courseId = student.courseId;
      if (student.currentYear) feeWhere.year = student.currentYear;
    } else if (school.category === 'COLLEGE_TVET') {
      feeWhere.programId = student.programId;
    } else {
      feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });
    const totalFees = fees.reduce((sum, f) => sum + parseFloat(f.amount), 0);
    const totalPaid = await Payment.sum('amount', { where: { studentId: student.id } }) || 0;
    const balance = totalFees - totalPaid;
    const isEligible = balance <= 0;

    // Get units/subjects
    let units = [];
    if (school.category === 'UNIVERSITY') {
      const unitWhere = { 
        schoolId: req.user.schoolId, 
        courseId: student.courseId 
      };
      if (semester) unitWhere.semester = parseInt(semester);
      if (student.currentYear) unitWhere.year = student.currentYear;
      
      units = await CourseUnit.findAll({ where: unitWhere });
    } else {
      const unitWhere = { 
        schoolId: req.user.schoolId, 
        classId: student.classId 
      };
      units = await Subject.findAll({ where: unitWhere });
    }

    res.json({
      success: true,
      examCard: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          admissionNumber: student.admissionNumber,
          course: student.course,
          class: student.class,
          currentYear: student.currentYear,
          currentSemester: student.currentSemester
        },
        fees: {
          total: totalFees,
          paid: totalPaid,
          balance,
          isEligible
        },
        units,
        generatedAt: new Date()
      }
    });
  } catch (error) {
    console.error('Get child exam card error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET child's timetable by admission number
app.get('/api/parents/me/children/:admissionNumber/timetable', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'PARENT') {
      return res.status(403).json({ 
        success: false, 
        message: 'This endpoint is only for parents' 
      });
    }

    const { admissionNumber } = req.params;

    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const parent = await Parent.findOne({
      where: { userId: req.user.id, studentId: student.id }
    });

    if (!parent) {
      return res.status(403).json({ 
        success: false, 
        message: 'You do not have access to this student' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    let where = { schoolId: req.user.schoolId };
    
    if (school.category === 'UNIVERSITY') {
      where.courseId = student.courseId;
      if (student.currentYear) where.year = student.currentYear;
      if (student.currentSemester) where.semester = student.currentSemester;
    } else {
      where.classId = student.classId;
    }

    const timetable = await Timetable.findAll({
      where,
      include: [
        { model: Subject, required: false },
        { model: CourseUnit, as: 'unit', required: false },
        { 
          model: Staff, 
          as: 'teacher',
          include: [{ model: User, attributes: ['firstName', 'lastName'] }],
          required: false 
        }
      ],
      order: [['day', 'ASC'], ['period', 'ASC']]
    });

    res.json({ 
      success: true, 
      timetable,
      student: {
        id: student.id,
        name: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get child timetable error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.put('/api/students/:id', authenticate, async (req, res) => {
  try {
    const student = await Student.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!student) return res.status(404).json({ message: 'Student not found' });

    // Check admission number uniqueness
    if (req.body.admissionNumber && req.body.admissionNumber !== student.admissionNumber) {
      const existingStudent = await Student.findOne({
        where: { 
          admissionNumber: req.body.admissionNumber,
          schoolId: req.user.schoolId,
          id: { [Op.ne]: student.id }
        }
      });
      if (existingStudent) {
        return res.status(400).json({ 
          message: `Admission number '${req.body.admissionNumber}' already exists.` 
        });
      }
    }

    const oldStudent = { ...student.toJSON() };
    await student.update(req.body);
    await createAuditLog(req, 'UPDATE', 'STUDENT', student.id, oldStudent, student);

    res.json({ success: true, student });
  } catch (error) {
    console.error('Update student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/students/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const student = await Student.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!student) return res.status(404).json({ message: 'Student not found' });

    await student.destroy();
    await createAuditLog(req, 'DELETE', 'STUDENT', req.params.id);

    res.json({ success: true, message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Delete student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Student Promotion Routes (Regular Schools)
app.post('/api/students/promote', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newClassId, academicYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'ECDE_PRIMARY_JSS' && school.category !== 'SENIOR_SECONDARY') {
      return res.status(400).json({ 
        message: 'Promotion endpoint is only for regular schools. Use progression endpoints for universities/TVET.' 
      });
    }

    await Student.update(
      { classId: newClassId },
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    await createAuditLog(req, 'PROMOTE', 'STUDENT', null, null, { studentIds, newClassId, academicYear });

    res.json({
      success: true,
      message: `${studentIds.length} students promoted successfully`
    });
  } catch (error) {
    console.error('Promote students error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== UNIVERSITY PROGRESSION ====================
app.post('/api/students/progress', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newYear, newSemester } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'UNIVERSITY') {
      return res.status(400).json({ 
        success: false,
        message: 'Year progression only applicable for university' 
      });
    }

    await Student.update(
      { 
        currentYear: newYear, 
        currentSemester: newSemester || 1 
      },
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROGRESS', 'STUDENT', null, null, { 
      studentIds, 
      newYear, 
      newSemester 
    });

    res.json({
      success: true,
      message: `${studentIds.length} students progressed to Year ${newYear}, Semester ${newSemester || 1}`
    });
  } catch (error) {
    console.error('Progress students error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== TVET MODULE PROGRESSION ====================
app.post('/api/students/progress-module', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newModule, newYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'COLLEGE_TVET') {
      return res.status(400).json({ 
        success: false,
        message: 'Module progression only applicable for TVET' 
      });
    }

    // Prepare update data
    const updateData = { currentModule: newModule };
    if (newYear) {
      updateData.currentYear = newYear;
    }

    await Student.update(
      updateData,
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROGRESS_MODULE', 'STUDENT', null, null, { 
      studentIds, 
      newModule,
      newYear 
    });

    let message = `${studentIds.length} students progressed to ${newModule}`;
    if (newYear) message += ` and Year ${newYear}`;

    res.json({
      success: true,
      message
    });
  } catch (error) {
    console.error('Progress module error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== TVET PROGRAM PROGRESSION ====================
app.post('/api/students/progress-program', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newProgramId, newYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'COLLEGE_TVET') {
      return res.status(400).json({ 
        success: false,
        message: 'Program progression only applicable for TVET' 
      });
    }

    // Verify program exists
    const program = await Program.findOne({
      where: { 
        id: newProgramId, 
        schoolId: req.user.schoolId 
      }
    });

    if (!program) {
      return res.status(404).json({ 
        success: false,
        message: 'Target program not found' 
      });
    }

    // Prepare update data - reset module to Module 1 when changing programs
    const updateData = { 
      programId: newProgramId,
      currentModule: 'Module 1'
    };
    
    if (newYear) {
      updateData.currentYear = newYear;
    }

    await Student.update(
      updateData,
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROGRESS_PROGRAM', 'STUDENT', null, null, { 
      studentIds, 
      newProgramId,
      newYear 
    });

    let message = `${studentIds.length} students progressed to ${program.name}`;
    if (newYear) message += ` and Year ${newYear}`;

    res.json({
      success: true,
      message
    });
  } catch (error) {
    console.error('Progress program error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== TVET YEAR-ONLY PROGRESSION ====================
app.post('/api/students/progress-year', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category !== 'COLLEGE_TVET') {
      return res.status(400).json({ 
        success: false,
        message: 'Year progression only applicable for TVET' 
      });
    }

    await Student.update(
      { currentYear: newYear },
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROGRESS_YEAR', 'STUDENT', null, null, { 
      studentIds, 
      newYear 
    });

    res.json({
      success: true,
      message: `${studentIds.length} students progressed to Year ${newYear}`
    });
  } catch (error) {
    console.error('Progress year error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== REGULAR SCHOOL PROMOTION ====================
app.post('/api/students/promote', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { studentIds, newClassId, academicYear } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (school.category === 'UNIVERSITY' || school.category === 'COLLEGE_TVET') {
      return res.status(400).json({ 
        success: false,
        message: 'This endpoint is for regular schools only. Use progression endpoints for university/TVET.' 
      });
    }

    // Verify class exists
    const targetClass = await Class.findOne({
      where: { 
        id: newClassId, 
        schoolId: req.user.schoolId 
      }
    });

    if (!targetClass) {
      return res.status(404).json({ 
        success: false,
        message: 'Target class not found' 
      });
    }

    await Student.update(
      { classId: newClassId },
      {
        where: {
          id: studentIds,
          schoolId: req.user.schoolId
        }
      }
    );

    // Create audit log
    await createAuditLog(req, 'PROMOTE', 'STUDENT', null, null, { 
      studentIds, 
      newClassId,
      academicYear 
    });

    res.json({
      success: true,
      message: `${studentIds.length} students promoted to ${targetClass.name}`
    });
  } catch (error) {
    console.error('Promote students error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== PARENT ROUTES ====================

app.get('/api/parents', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    
    // If user is a parent, only show their own records
    if (req.user.role === 'PARENT') {
      where.userId = req.user.id;
    }
    
    // If studentId is provided in query, filter by that student
    const { studentId } = req.query;
    if (studentId) {
      where.studentId = studentId;
    }

    const parents = await Parent.findAll({
      where,
      include: [
        { 
          model: User, 
          attributes: ['id', 'firstName', 'lastName', 'email', 'phone'],
          required: false 
        },
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ 
      success: true, 
      parents,
      count: parents.length
    });
  } catch (error) {
    console.error('Get parents error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/parents/:id', authenticate, async (req, res) => {
  try {
    const parent = await Parent.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [
        { model: User, attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] }
      ]
    });
    
    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Parent record not found' 
      });
    }
    
    res.json({ success: true, parent });
  } catch (error) {
    console.error('Get parent error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.post('/api/parents', authenticate, async (req, res) => {
  try {
    const { 
      userId, 
      studentId, 
      relationship, 
      isPrimary, 
      emergencyContact,
      occupation,
      employer,
      monthlyIncome 
    } = req.body;

    // Check if user exists
    const user = await User.findOne({
      where: { id: userId, schoolId: req.user.schoolId }
    });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'User not found in this school' 
      });
    }

    // Check if student exists
    const student = await Student.findOne({
      where: { id: studentId, schoolId: req.user.schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found in this school' 
      });
    }

    // Check if relationship already exists
    const existing = await Parent.findOne({
      where: { userId, studentId }
    });

    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'This parent-student relationship already exists' 
      });
    }

    // If this is marked as primary, unmark any other primary for this student
    if (isPrimary) {
      await Parent.update(
        { isPrimary: false },
        { where: { studentId, isPrimary: true } }
      );
    }

    const parent = await Parent.create({
      userId,
      studentId,
      relationship: relationship || 'Parent',
      isPrimary: isPrimary || false,
      emergencyContact: emergencyContact || false,
      occupation,
      employer,
      monthlyIncome,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'PARENT', parent.id, null, parent);

    const createdParent = await Parent.findByPk(parent.id, {
      include: [
        { model: User, attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] }
      ]
    });

    res.status(201).json({ 
      success: true, 
      parent: createdParent,
      message: 'Parent record created successfully'
    });
  } catch (error) {
    console.error('Create parent error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.put('/api/parents/:id', authenticate, async (req, res) => {
  try {
    const parent = await Parent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Parent record not found' 
      });
    }

    // If updating isPrimary to true, unmark any other primary for this student
    if (req.body.isPrimary && !parent.isPrimary) {
      await Parent.update(
        { isPrimary: false },
        { where: { studentId: parent.studentId, isPrimary: true } }
      );
    }

    const oldParent = { ...parent.toJSON() };
    await parent.update(req.body);
    await createAuditLog(req, 'UPDATE', 'PARENT', parent.id, oldParent, parent);

    const updatedParent = await Parent.findByPk(parent.id, {
      include: [
        { model: User, attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] },
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] }
      ]
    });

    res.json({ 
      success: true, 
      parent: updatedParent,
      message: 'Parent record updated successfully'
    });
  } catch (error) {
    console.error('Update parent error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.delete('/api/parents/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const parent = await Parent.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Parent record not found' 
      });
    }

    await parent.destroy();
    await createAuditLog(req, 'DELETE', 'PARENT', req.params.id);

    res.json({ 
      success: true, 
      message: 'Parent record deleted successfully' 
    });
  } catch (error) {
    console.error('Delete parent error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/parents/:parentId/students', authenticate, async (req, res) => {
  try {
    const parentId = req.params.parentId;
    
    const parent = await Parent.findOne({
      where: { 
        id: parentId,
        schoolId: req.user.schoolId 
      }
    });

    if (!parent) {
      return res.status(404).json({ 
        success: false, 
        message: 'Parent not found' 
      });
    }

    // Find all students linked to this parent
    const parents = await Parent.findAll({
      where: { userId: parent.userId },
      include: [{
        model: Student,
        include: [
          { model: Class },
          { model: Course }
        ]
      }]
    });

    const students = parents.map(p => p.Student).filter(s => s);

    res.json({ 
      success: true, 
      students,
      count: students.length
    });
  } catch (error) {
    console.error('Get parent students error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== SUBJECT ROUTES ====================

app.post('/api/subjects', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, code, classId, teacherId, isCompulsory, category, maxMarks, passMarks } = req.body;

    const subject = await Subject.create({
      name,
      code,
      classId,
      teacherId,
      isCompulsory,
      category,
      maxMarks,
      passMarks,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'SUBJECT', subject.id, null, subject);

    res.status(201).json({ success: true, subject });
  } catch (error) {
    console.error('Create subject error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/subjects', authenticate, async (req, res) => {
  try {
    const { classId } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (classId) where.classId = classId;

    const subjects = await Subject.findAll({
      where,
      include: [
        { model: Class, required: false },
        { model: User, as: 'teacher', attributes: ['firstName', 'lastName'], required: false }
      ]
    });
    
    res.json({ success: true, subjects });
  } catch (error) {
    console.error('Get subjects error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/subjects/:id', authenticate, async (req, res) => {
  try {
    const subject = await Subject.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!subject) {
      return res.status(404).json({ message: 'Subject not found' });
    }
    
    res.json({ success: true, subject });
  } catch (error) {
    console.error('Get subject error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/subjects/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const subject = await Subject.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!subject) return res.status(404).json({ message: 'Subject not found' });

    const oldSubject = { ...subject.toJSON() };
    await subject.update(req.body);
    await createAuditLog(req, 'UPDATE', 'SUBJECT', subject.id, oldSubject, subject);

    res.json({ success: true, subject });
  } catch (error) {
    console.error('Update subject error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/subjects/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const subject = await Subject.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!subject) return res.status(404).json({ message: 'Subject not found' });

    await subject.destroy();
    await createAuditLog(req, 'DELETE', 'SUBJECT', req.params.id);

    res.json({ success: true, message: 'Subject deleted successfully' });
  } catch (error) {
    console.error('Delete subject error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
// ==================== COMPLETE CORRECTED EXAM ROUTES ====================
// ==================== UPDATED ROUTES WITH CORRECT ALIASES ====================

// GET SINGLE EXAM BY ID
app.get('/api/exams/:id', authenticate, async (req, res) => {
  try {
    console.log('📋 Fetching exam with ID:', req.params.id);
    
    const exam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: Course, as: 'course', attributes: ['id', 'name', 'code'], required: false },
        { model: Program, as: 'program', attributes: ['id', 'name', 'code'], required: false },
        { model: CourseUnit, as: 'courseUnit', attributes: ['id', 'name', 'code', 'creditHours'], required: false }, // Changed from 'unit'
        { model: Class, as: 'class', attributes: ['id', 'name'], required: false },
        { model: Subject, as: 'subject', attributes: ['id', 'name', 'code'], required: false },
        { model: Faculty, as: 'faculty', attributes: ['id', 'name'], required: false },
        { model: Department, as: 'department', attributes: ['id', 'name'], required: false }
      ]
    });
    
    if (!exam) {
      console.log('❌ Exam not found:', req.params.id);
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    console.log('✅ Exam found:', exam.name);
    res.json({ 
      success: true, 
      exam 
    });
  } catch (error) {
    console.error('❌ Get exam by ID error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET ALL EXAMS WITH FILTERS
app.get('/api/exams', authenticate, async (req, res) => {
  try {
    console.log('📋 Fetching exams with query:', req.query);
    
    const { 
      classId, subjectId, courseId, programId, facultyId, 
      type, term, year, semester, module, unitId 
    } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (!school) {
      return res.status(400).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    // Apply filters based on school category
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
      if (facultyId) where.facultyId = facultyId;
      if (year) where.year = parseInt(year);
      if (semester) where.semester = parseInt(semester);
      if (unitId) where.unitId = unitId;
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (programId) where.programId = programId;
      if (year) where.year = parseInt(year);
      if (module) where.module = parseInt(module);
      if (unitId) where.unitId = unitId;
    } 
    else {
      if (classId) where.classId = classId;
      if (subjectId) where.subjectId = subjectId;
    }
    
    if (type) where.type = type;
    if (term) where.term = term;

    let exams;
    
    try {
      if (school.category === 'UNIVERSITY') {
        exams = await Exam.findAll({
          where,
          include: [
            { model: Course, as: 'course', attributes: ['id', 'name', 'code'], required: false },
            { model: Faculty, as: 'faculty', attributes: ['id', 'name'], required: false },
            { model: Department, as: 'department', attributes: ['id', 'name'], required: false },
            { model: CourseUnit, as: 'courseUnit', attributes: ['id', 'name', 'code', 'creditHours'], required: false } // Changed from 'unit'
          ],
          order: [['date', 'DESC'], ['createdAt', 'DESC']]
        });
      } 
      else if (school.category === 'COLLEGE_TVET') {
        exams = await Exam.findAll({
          where,
          include: [
            { model: Program, as: 'program', attributes: ['id', 'name', 'code'], required: false },
            { model: CourseUnit, as: 'courseUnit', attributes: ['id', 'name', 'code', 'creditHours'], required: false } // Changed from 'unit'
          ],
          order: [['date', 'DESC'], ['createdAt', 'DESC']]
        });
      } 
      else {
        exams = await Exam.findAll({
          where,
          include: [
            { model: Class, as: 'class', attributes: ['id', 'name', 'capacity'], required: false },
            { model: Subject, as: 'subject', attributes: ['id', 'name', 'code'], required: false }
          ],
          order: [['date', 'DESC'], ['createdAt', 'DESC']]
        });
      }
    } catch (includeError) {
      console.error('Error with includes, falling back to simple query:', includeError);
      // Fallback to simple query without includes
      exams = await Exam.findAll({ 
        where, 
        order: [['date', 'DESC'], ['createdAt', 'DESC']] 
      });
    }
    
    console.log(`✅ Found ${exams.length} exams`);
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// CREATE EXAM
app.post('/api/exams', authenticate, async (req, res) => {
  try {
    console.log('📝 Creating exam with data:', req.body);
    
    const {
      name, type, classId, subjectId, term, academicYear,
      date, startTime, endTime, maxMarks, weightage,
      courseId, facultyId, departmentId, unitId, year, semester,
      programId, module,
      examHall, invigilator, invigilatorId, schoolId
    } = req.body;

    // Get the school to determine category
    const school = await School.findByPk(req.user.schoolId || schoolId);
    
    if (!school) {
      return res.status(400).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    // Validate required fields based on school category
    if (school.category === 'UNIVERSITY') {
      if (!courseId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Course ID is required for university exams' 
        });
      }
    } 
    else if (school.category === 'COLLEGE_TVET') {
      if (!programId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program ID is required for TVET exams' 
        });
      }
    } 
    else {
      if (!classId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Class ID is required for regular schools' 
        });
      }
      if (!subjectId) {
        return res.status(400).json({ 
          success: false, 
          message: 'Subject ID is required for regular schools' 
        });
      }
    }

    // Prepare exam data
    const examData = {
      name,
      type,
      term: term || (school.category === 'UNIVERSITY' ? `Semester ${semester || 1}` : 
                     school.category === 'COLLEGE_TVET' ? `Module ${module || 1}` : 'Term 1'),
      academicYear: academicYear || new Date().getFullYear().toString(),
      date,
      startTime: startTime || null,
      endTime: endTime || null,
      maxMarks: maxMarks || 100,
      weightage: weightage || null,
      examHall: examHall || null,
      invigilator: invigilator || null,
      invigilatorId: invigilatorId || null,
      schoolId: req.user.schoolId || schoolId,
      isPublished: false,
      resultsPublished: false,
      // University fields
      courseId: school.category === 'UNIVERSITY' ? courseId : null,
      facultyId: school.category === 'UNIVERSITY' ? (facultyId || null) : null,
      departmentId: school.category === 'UNIVERSITY' ? (departmentId || null) : null,
      unitId: (school.category === 'UNIVERSITY' || school.category === 'COLLEGE_TVET') ? (unitId || null) : null,
      year: (school.category === 'UNIVERSITY' || school.category === 'COLLEGE_TVET') ? (year ? parseInt(year) : null) : null,
      semester: school.category === 'UNIVERSITY' ? (semester ? parseInt(semester) : null) : null,
      // TVET fields
      programId: school.category === 'COLLEGE_TVET' ? programId : null,
      module: school.category === 'COLLEGE_TVET' ? (module ? parseInt(module) : null) : null,
      // Regular school fields
      classId: !['UNIVERSITY', 'COLLEGE_TVET'].includes(school.category) ? classId : null,
      subjectId: !['UNIVERSITY', 'COLLEGE_TVET'].includes(school.category) ? subjectId : null
    };

    console.log('📝 Creating exam with processed data:', examData);

    // Create the exam
    const exam = await Exam.create(examData);

    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'CREATE', 'EXAM', exam.id, null, exam);
    }

    // Fetch the created exam with associations
    const createdExam = await Exam.findByPk(exam.id, {
      include: [
        { model: Course, as: 'course', required: false },
        { model: Program, as: 'program', required: false },
        { model: CourseUnit, as: 'courseUnit', required: false }, // Changed from 'unit'
        { model: Class, as: 'class', required: false },
        { model: Subject, as: 'subject', required: false },
        { model: Faculty, as: 'faculty', required: false },
        { model: Department, as: 'department', required: false }
      ]
    });

    res.status(201).json({ 
      success: true, 
      exam: createdExam 
    });

  } catch (error) {
    console.error('❌ Create exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPDATE EXAM
app.put('/api/exams/:id', authenticate, async (req, res) => {
  try {
    console.log('📝 Updating exam:', req.params.id);
    
    const exam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!exam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    const oldExam = { ...exam.toJSON() };
    await exam.update(req.body);
    
    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'UPDATE', 'EXAM', exam.id, oldExam, exam);
    }
    
    // Fetch updated exam with associations
    const updatedExam = await Exam.findByPk(exam.id, {
      include: [
        { model: Course, as: 'course', required: false },
        { model: Program, as: 'program', required: false },
        { model: CourseUnit, as: 'courseUnit', required: false }, // Changed from 'unit'
        { model: Class, as: 'class', required: false },
        { model: Subject, as: 'subject', required: false },
        { model: Faculty, as: 'faculty', required: false },
        { model: Department, as: 'department', required: false }
      ]
    });
    
    console.log('✅ Exam updated successfully');
    res.json({ 
      success: true, 
      exam: updatedExam 
    });
  } catch (error) {
    console.error('❌ Update exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET EXAMS BY COURSE
app.get('/api/exams/by-course/:courseId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        courseId: req.params.courseId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: CourseUnit, as: 'courseUnit', required: false } // Changed from 'unit'
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by course error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// GET EXAMS BY PROGRAM
app.get('/api/exams/by-program/:programId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        programId: req.params.programId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: CourseUnit, as: 'courseUnit', required: false } // Changed from 'unit'
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// DUPLICATE EXAM
app.post('/api/exams/:id/duplicate', authenticate, async (req, res) => {
  try {
    console.log('📋 Duplicating exam:', req.params.id);
    
    const { newName, newDate } = req.body;
    
    const sourceExam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!sourceExam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    // Create new exam object without the id and timestamps
    const examData = sourceExam.toJSON();
    delete examData.id;
    delete examData.createdAt;
    delete examData.updatedAt;
    delete examData.publishedAt;
    
    // Update with new values
    examData.name = newName || `Copy of ${examData.name}`;
    examData.date = newDate || examData.date;
    examData.isPublished = false;
    examData.resultsPublished = false;

    const newExam = await Exam.create(examData);

    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'DUPLICATE', 'EXAM', newExam.id, null, { sourceId: req.params.id });
    }

    // Fetch with associations
    const createdExam = await Exam.findByPk(newExam.id, {
      include: [
        { model: Course, as: 'course', required: false },
        { model: Program, as: 'program', required: false },
        { model: CourseUnit, as: 'courseUnit', required: false }, // Changed from 'unit'
        { model: Class, as: 'class', required: false },
        { model: Subject, as: 'subject', required: false }
      ]
    });

    console.log('✅ Exam duplicated successfully');
    res.json({ 
      success: true, 
      exam: createdExam 
    });
  } catch (error) {
    console.error('❌ Duplicate exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ==================== DELETE EXAM WITH CASCADE ====================
app.delete('/api/exams/:id', authenticate, async (req, res) => {
  try {
    console.log('🗑️ Deleting exam:', req.params.id);
    
    const exam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!exam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    // Check for associated results
    const resultsCount = await Result.count({
      where: { examId: req.params.id }
    });

    if (resultsCount > 0) {
      console.log(`📊 Found ${resultsCount} results linked to this exam`);
      
      // Delete all associated results first
      await Result.destroy({
        where: { examId: req.params.id }
      });
      
      console.log(`✅ Deleted ${resultsCount} associated results`);
    }

    // Then delete the exam
    await exam.destroy();
    
    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'DELETE', 'EXAM', req.params.id, null, { 
        deletedResults: resultsCount 
      });
    }
    
    console.log(`✅ Exam and ${resultsCount} associated results deleted successfully`);
    res.json({ 
      success: true, 
      message: `Exam deleted successfully along with ${resultsCount} associated results` 
    });

  } catch (error) {
    console.error('❌ Delete exam error:', error);
    
    // Handle foreign key constraint errors
    if (error.name === 'SequelizeForeignKeyConstraintError') {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot delete exam because it has associated results. Please delete results first.',
        error: 'FK_CONSTRAINT_VIOLATION'
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== PUBLISH EXAM RESULTS ====================
app.put('/api/exams/:id/publish', authenticate, async (req, res) => {
  try {
    console.log('📢 Publishing exam results:', req.params.id);
    
    const exam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!exam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    const { isPublished, resultsPublished } = req.body;
    
    await exam.update({ 
      isPublished: isPublished !== undefined ? isPublished : true,
      resultsPublished: resultsPublished !== undefined ? resultsPublished : true,
      publishedAt: new Date().toISOString()
    });
    
    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'PUBLISH', 'EXAM', exam.id, null, { 
        isPublished: exam.isPublished,
        resultsPublished: exam.resultsPublished,
        publishedAt: exam.publishedAt
      });
    }
    
    console.log('✅ Exam published successfully');
    res.json({ 
      success: true, 
      message: 'Exam results published successfully',
      exam
    });
  } catch (error) {
    console.error('❌ Publish exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== BULK DELETE EXAMS ====================
app.post('/api/exams/bulk-delete', authenticate, async (req, res) => {
  try {
    const { examIds } = req.body;
    
    if (!examIds || !Array.isArray(examIds) || examIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide an array of exam IDs' 
      });
    }

    console.log('🗑️ Bulk deleting exams:', examIds);
    
    let totalResultsDeleted = 0;
    let totalExamsDeleted = 0;
    const errors = [];

    // Process each exam
    for (const examId of examIds) {
      try {
        // Check if exam exists and belongs to user's school
        const exam = await Exam.findOne({
          where: { 
            id: examId,
            schoolId: req.user.schoolId 
          }
        });

        if (!exam) {
          errors.push({ examId, error: 'Exam not found' });
          continue;
        }

        // Delete associated results first
        const resultsDeleted = await Result.destroy({
          where: { examId: examId }
        });
        
        totalResultsDeleted += resultsDeleted;

        // Then delete the exam
        await exam.destroy();
        totalExamsDeleted++;

        console.log(`✅ Deleted exam ${examId} with ${resultsDeleted} results`);

      } catch (err) {
        console.error(`❌ Error deleting exam ${examId}:`, err);
        errors.push({ examId, error: err.message });
      }
    }

    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'BULK_DELETE', 'EXAM', null, null, { 
        examsDeleted: totalExamsDeleted,
        resultsDeleted: totalResultsDeleted,
        errors: errors.length
      });
    }

    res.json({ 
      success: true, 
      message: `Successfully deleted ${totalExamsDeleted} exams and ${totalResultsDeleted} results`,
      data: {
        examsDeleted: totalExamsDeleted,
        resultsDeleted: totalResultsDeleted,
        errors: errors
      }
    });

  } catch (error) {
    console.error('❌ Bulk delete exams error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== DUPLICATE EXAM ====================
app.post('/api/exams/:id/duplicate', authenticate, async (req, res) => {
  try {
    console.log('📋 Duplicating exam:', req.params.id);
    
    const { newName, newDate } = req.body;
    
    const sourceExam = await Exam.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!sourceExam) {
      return res.status(404).json({ 
        success: false, 
        message: 'Exam not found' 
      });
    }

    // Create new exam object without the id and timestamps
    const examData = sourceExam.toJSON();
    delete examData.id;
    delete examData.createdAt;
    delete examData.updatedAt;
    delete examData.publishedAt;
    
    // Update with new values
    examData.name = newName || `Copy of ${examData.name}`;
    examData.date = newDate || examData.date;
    examData.isPublished = false;
    examData.resultsPublished = false;

    const newExam = await Exam.create(examData);

    // Create audit log
    if (typeof createAuditLog === 'function') {
      await createAuditLog(req, 'DUPLICATE', 'EXAM', newExam.id, null, { sourceId: req.params.id });
    }

    // Fetch with associations
    const createdExam = await Exam.findByPk(newExam.id, {
      include: [
        { model: Course, as: 'course', required: false },
        { model: Program, as: 'program', required: false },
        { model: CourseUnit, as: 'unit', required: false },
        { model: Class, as: 'class', required: false },
        { model: Subject, as: 'subject', required: false }
      ]
    });

    console.log('✅ Exam duplicated successfully');
    res.json({ 
      success: true, 
      exam: createdExam 
    });
  } catch (error) {
    console.error('❌ Duplicate exam error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== GET EXAMS BY COURSE ====================
app.get('/api/exams/by-course/:courseId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        courseId: req.params.courseId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: CourseUnit, as: 'unit', required: false }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by course error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET EXAMS BY PROGRAM ====================
app.get('/api/exams/by-program/:programId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        programId: req.params.programId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: CourseUnit, as: 'unit', required: false }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET EXAMS BY CLASS ====================
app.get('/api/exams/by-class/:classId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        classId: req.params.classId,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: Subject, as: 'subject', required: false }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by class error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET EXAMS BY TEACHER ====================
app.get('/api/exams/by-teacher/:teacherId', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { 
        invigilatorId: req.params.teacherId,
        schoolId: req.user.schoolId 
      },
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get exams by teacher error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET UPCOMING EXAMS ====================
app.get('/api/exams/upcoming', authenticate, async (req, res) => {
  try {
    const today = new Date();
    const exams = await Exam.findAll({
      where: {
        schoolId: req.user.schoolId,
        date: { [Op.gte]: today }
      },
      order: [['date', 'ASC']],
      limit: 10
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get upcoming exams error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET PAST EXAMS ====================
app.get('/api/exams/past', authenticate, async (req, res) => {
  try {
    const today = new Date();
    const exams = await Exam.findAll({
      where: {
        schoolId: req.user.schoolId,
        date: { [Op.lt]: today }
      },
      order: [['date', 'DESC']],
      limit: 20
    });
    
    res.json({ success: true, exams });
  } catch (error) {
    console.error('❌ Get past exams error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// ==================== GET EXAMS WITH RESULTS STATISTICS ====================
app.get('/api/exams/with-results', authenticate, async (req, res) => {
  try {
    const exams = await Exam.findAll({
      where: { schoolId: req.user.schoolId },
      include: [
        { 
          model: Result,
          as: 'results',
          required: false,
          attributes: ['id', 'marks', 'grade', 'points']
        }
      ],
      order: [['date', 'DESC']]
    });

    // Add statistics to each exam
    const examsWithStats = exams.map(exam => {
      const results = exam.results || [];
      const totalStudents = results.length;
      const averageMarks = totalStudents > 0 
        ? (results.reduce((sum, r) => sum + (r.marks || 0), 0) / totalStudents).toFixed(2)
        : 0;
      
      return {
        ...exam.toJSON(),
        statistics: {
          totalStudents,
          averageMarks,
          totalPoints: results.reduce((sum, r) => sum + (r.points || 0), 0),
          passCount: results.filter(r => (r.marks || 0) >= 50).length,
          passRate: totalStudents > 0 
            ? ((results.filter(r => (r.marks || 0) >= 50).length / totalStudents) * 100).toFixed(2)
            : 0
        }
      };
    });

    res.json({ success: true, exams: examsWithStats });
  } catch (error) {
    console.error('❌ Get exams with results error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});
// ==================== RESULTS ROUTES ====================

const calculateGradeFromMarksWithSystem = (marks, maxMarks, gradingSystem) => {
  if (!gradingSystem || !gradingSystem.getGrade) {
    return { grade: 'N/A', code: 'NG', points: 0, color: 'gray' };
  }
  const percentage = maxMarks > 0 ? (marks / maxMarks) * 100 : 0;
  return gradingSystem.getGrade(percentage);
};

app.post('/api/results', authenticate, checkPermission('manage_results'), async (req, res) => {
  try {
    const resultsData = req.body;
    const resultsArray = Array.isArray(resultsData) ? resultsData : [resultsData];

    const createdResults = [];

    for (const item of resultsArray) {
      const { studentId, examId, subjectId, unitId, marks, isAbsent, remarks, description } = item;

      const student = await Student.findOne({ where: { id: studentId, schoolId: req.user.schoolId } });
      if (!student) {
        return res.status(400).json({ message: `Student ${studentId} not found in your school` });
      }

      const exam = await Exam.findOne({ where: { id: examId, schoolId: req.user.schoolId } });
      if (!exam) {
        return res.status(400).json({ message: `Exam ${examId} not found in your school` });
      }

      const school = await School.findByPk(req.user.schoolId);
      const gradingSystemObj = GRADING_SYSTEMS[school.gradingSystem] || GRADING_SYSTEMS.CBC;

      const maxMarks = exam.maxMarks || 100;
      const gradeInfo = isAbsent
        ? { grade: 'ABS', code: 'ABS', points: 0, color: 'gray' }
        : calculateGradeFromMarksWithSystem(marks, maxMarks, gradingSystemObj);

      const whereClause = { studentId, examId };
      if (subjectId) whereClause.subjectId = subjectId;
      if (unitId) whereClause.unitId = unitId;

      const existing = await Result.findOne({ where: whereClause });
      if (existing) {
        return res.status(400).json({
          message: `Result already exists for student ${studentId} and exam ${examId}`
        });
      }

      const result = await Result.create({
        studentId,
        examId,
        subjectId: subjectId || null,
        unitId: unitId || null,
        marks: isAbsent ? 0 : marks,
        grade: gradeInfo.grade,
        gradeCode: gradeInfo.code,
        points: gradeInfo.points,
        remarks,
        description,
        isAbsent: isAbsent || false,
        gradingSystem: school.gradingSystem
      });

      createdResults.push(result);
    }

    await createAuditLog(req, 'CREATE', 'RESULT', null, null, { count: createdResults.length });
    res.status(201).json({ success: true, results: createdResults });
  } catch (error) {
    console.error('Create result error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/results', authenticate, async (req, res) => {
  try {
    const { studentId, examId } = req.query;
    const where = {};
    
    if (studentId) where.studentId = studentId;
    if (examId) where.examId = examId;

    const results = await Result.findAll({
      where,
      include: [
        { 
          model: Exam,
          attributes: ['id', 'name', 'date', 'type'],
          required: false
        },
        { 
          model: Subject,
          attributes: ['id', 'name', 'code'],
          required: false
        },
        { 
          model: CourseUnit,
          as: 'CourseUnit',
          attributes: ['id', 'name', 'code'],
          required: false
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    res.json({ success: true, results });
  } catch (error) {
    console.error('Get results error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
// ==================== FIXED RESULTS BY ADMISSION ENDPOINT ====================

// GET results by admission number - WITH RECALCULATED GRADES
app.get('/api/results/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    console.log(`🔍 Looking up student with admission: ${admissionNumber}`);

    // Find student by admission number with all necessary includes
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { 
          model: Course,
          required: false,
          attributes: ['id', 'name', 'code']
        },
        { 
          model: Class,
          required: false,
          attributes: ['id', 'name']
        },
        {
          model: Program,
          required: false,
          attributes: ['id', 'name']
        }
      ]
    });

    if (!student) {
      console.log(`❌ Student not found with admission: ${admissionNumber}`);
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    console.log(`✅ Found student: ${student.firstName} ${student.lastName}`);

    // Get the school to know the grading system
    const school = await School.findByPk(req.user.schoolId);
    console.log(`🏫 School category: ${school.category}, Grading system: ${school.gradingSystem}`);
    
    // Get the grading system based on school category
    const gradingSystem = getGradingSystem(school.category);

    // Get all results for this student with exam and unit/subject details
    const results = await Result.findAll({
      where: { studentId: student.id },
      include: [
        { 
          model: Exam,
          attributes: ['id', 'name', 'date', 'type', 'maxMarks'],
          required: false
        },
        { 
          model: Subject,
          attributes: ['id', 'name', 'code'],
          required: false
        },
        { 
          model: CourseUnit,
          as: 'CourseUnit',
          attributes: ['id', 'name', 'code', 'semester', 'year', 'credits'],
          required: false
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    console.log(`📊 Found ${results.length} results for student`);

    // Get all exams to cross-reference (in case the exam wasn't included properly)
    const examIds = [...new Set(results.map(r => r.examId).filter(id => id))];
    const examsMap = {};
    if (examIds.length > 0) {
      const exams = await Exam.findAll({
        where: { id: examIds },
        attributes: ['id', 'name', 'date', 'type', 'maxMarks']
      });
      exams.forEach(exam => {
        examsMap[exam.id] = exam;
      });
    }

    // Get all units to cross-reference
    const unitIds = [...new Set(results.map(r => r.unitId).filter(id => id))];
    const unitsMap = {};
    if (unitIds.length > 0) {
      const units = await CourseUnit.findAll({
        where: { id: unitIds },
        attributes: ['id', 'name', 'code', 'semester', 'year', 'credits']
      });
      units.forEach(unit => {
        unitsMap[unit.id] = unit;
      });
    }

    // Process each result to recalculate grade based on current school category
    const processedResults = results.map(result => {
      // Get marks (default to 0 if not present)
      const marks = result.marks || 0;
      
      // Get max marks from exam if available
      let maxMarks = 100;
      let examName = 'Examination';
      let examDate = null;
      
      // Try to get exam from the included association
      if (result.Exam) {
        maxMarks = result.Exam.maxMarks || 100;
        examName = result.Exam.name || 'Examination';
        examDate = result.Exam.date;
      } 
      // If not, try the examsMap
      else if (result.examId && examsMap[result.examId]) {
        maxMarks = examsMap[result.examId].maxMarks || 100;
        examName = examsMap[result.examId].name || 'Examination';
        examDate = examsMap[result.examId].date;
      }
      
      // Recalculate grade based on current school category
      const gradeInfo = gradingSystem.getGrade(marks);
      
      // Get unit/subject name based on school category
      let itemName = 'General';
      let unitCode = '';
      let unitCredits = null;
      let unitSemester = null;
      let unitYear = null;
      
      if (school.category === 'UNIVERSITY') {
        // Try to get unit from included association
        if (result.CourseUnit) {
          itemName = result.CourseUnit.name || 'Course Unit';
          unitCode = result.CourseUnit.code || '';
          unitCredits = result.CourseUnit.credits;
          unitSemester = result.CourseUnit.semester;
          unitYear = result.CourseUnit.year;
        }
        // Try unitsMap
        else if (result.unitId && unitsMap[result.unitId]) {
          itemName = unitsMap[result.unitId].name || 'Course Unit';
          unitCode = unitsMap[result.unitId].code || '';
          unitCredits = unitsMap[result.unitId].credits;
          unitSemester = unitsMap[result.unitId].semester;
          unitYear = unitsMap[result.unitId].year;
        }
        // Default
        else {
          itemName = 'Course Unit';
        }
      } 
      else if (school.category === 'COLLEGE_TVET') {
        if (result.CourseUnit) {
          itemName = result.CourseUnit.name || 'Module';
        } else if (result.unitId && unitsMap[result.unitId]) {
          itemName = unitsMap[result.unitId].name || 'Module';
        } else {
          itemName = 'Module';
        }
      } 
      else {
        // Regular school - use subject
        if (result.Subject) {
          itemName = result.Subject.name || 'Subject';
        } else {
          itemName = 'Subject';
        }
      }
      
      return {
        id: result.id,
        examId: result.examId,
        studentId: result.studentId,
        subjectId: result.subjectId,
        unitId: result.unitId,
        marks: marks,
        // Use recalculated values instead of stored ones
        grade: gradeInfo.grade,
        gradeCode: gradeInfo.code,
        points: gradeInfo.points,
        isAbsent: result.isAbsent || false,
        remarks: result.remarks,
        description: result.description,
        createdAt: result.createdAt,
        updatedAt: result.updatedAt,
        // Include exam details
        exam: {
          id: result.Exam?.id || result.examId,
          name: examName,
          date: examDate,
          type: result.Exam?.type,
          maxMarks: maxMarks
        },
        // Include unit/subject details
        unit: result.CourseUnit ? {
          id: result.CourseUnit.id,
          name: result.CourseUnit.name,
          code: result.CourseUnit.code,
          semester: result.CourseUnit.semester,
          year: result.CourseUnit.year,
          credits: result.CourseUnit.credits
        } : (result.unitId && unitsMap[result.unitId] ? {
          id: unitsMap[result.unitId].id,
          name: unitsMap[result.unitId].name,
          code: unitsMap[result.unitId].code,
          semester: unitsMap[result.unitId].semester,
          year: unitsMap[result.unitId].year,
          credits: unitsMap[result.unitId].credits
        } : null),
        subject: result.Subject ? {
          id: result.Subject.id,
          name: result.Subject.name,
          code: result.Subject.code
        } : null,
        // For frontend compatibility - flattened fields
        examName: examName,
        unitName: itemName,
        subjectName: itemName,
        examDate: examDate,
        unitCode: unitCode,
        unitCredits: unitCredits,
        unitSemester: unitSemester,
        unitYear: unitYear
      };
    });

    // Determine course name for student
    let courseName = 'N/A';
    if (school.category === 'UNIVERSITY') {
      if (student.Course) {
        courseName = student.Course.name;
      } else if (student.courseId) {
        // Try to fetch course if not included
        const course = await Course.findByPk(student.courseId);
        courseName = course ? course.name : 'N/A';
      }
    } else if (school.category === 'COLLEGE_TVET') {
      if (student.Program) {
        courseName = student.Program.name;
      }
    } else {
      if (student.Class) {
        courseName = student.Class.name;
      }
    }

    // Determine year of study
    let yearOfStudy = 'N/A';
    if (student.currentYear) {
      yearOfStudy = `Year ${student.currentYear}`;
    } else if (student.year) {
      yearOfStudy = `Year ${student.year}`;
    }

    console.log(`✅ Processed ${processedResults.length} results with recalculated grades`);

    res.json({ 
      success: true, 
      results: processedResults,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber,
        course: student.Course ? {
          id: student.Course.id,
          name: student.Course.name,
          code: student.Course.code
        } : null,
        class: student.Class ? {
          id: student.Class.id,
          name: student.Class.name
        } : null,
        program: student.Program ? {
          id: student.Program.id,
          name: student.Program.name
        } : null,
        courseName: courseName,
        currentYear: student.currentYear,
        yearOfStudy: yearOfStudy,
        currentSemester: student.currentSemester
      }
    });
  } catch (error) {
    console.error('❌ Get results by admission error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});
// GET /api/results/exam/:examId - Get all results for a specific exam
app.get('/api/results/exam/:examId', authenticate, async (req, res) => {  // <-- ADD authenticate here
  try {
    const { examId } = req.params;
    
    const results = await Result.findAll({
      where: { examId },
      include: [
        {
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
        },
        {
          model: Exam,
          attributes: ['id', 'name', 'maxMarks', 'unitId', 'subjectId']
        }
      ]
    });
    
    res.json({ 
      success: true, 
      results,
      count: results.length 
    });
  } catch (error) {
    console.error('Error fetching exam results:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch exam results',
      error: error.message 
    });
  }
});


app.get('/api/results/:id', authenticate, async (req, res) => {
  try {
    const result = await Result.findOne({
      where: { id: req.params.id },
      include: [
        { model: Student },
        { model: Exam },
        { model: Subject },
        { model: CourseUnit, as: 'CourseUnit' }
      ]
    });

    if (!result) {
      return res.status(404).json({ message: 'Result not found' });
    }

    const student = await Student.findByPk(result.studentId);
    if (student.schoolId !== req.user.schoolId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json({ success: true, result });
  } catch (error) {
    console.error('Get result error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/results/:id', authenticate, checkPermission('manage_results'), async (req, res) => {
  try {
    const result = await Result.findByPk(req.params.id);
    if (!result) {
      return res.status(404).json({ message: 'Result not found' });
    }

    const student = await Student.findByPk(result.studentId);
    if (student.schoolId !== req.user.schoolId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    const oldResult = { ...result.toJSON() };
    const { marks, isAbsent, remarks, description } = req.body;

    let gradeInfo = { grade: result.grade, gradeCode: result.gradeCode, points: result.points };
    if ((marks !== undefined && marks !== result.marks) || (isAbsent !== undefined && isAbsent !== result.isAbsent)) {
      const exam = await Exam.findByPk(result.examId);
      const school = await School.findByPk(req.user.schoolId);
      const gradingSystemObj = GRADING_SYSTEMS[school.gradingSystem] || GRADING_SYSTEMS.CBC;
      const maxMarks = exam.maxMarks || 100;

      gradeInfo = isAbsent
        ? { grade: 'ABS', code: 'ABS', points: 0 }
        : calculateGradeFromMarksWithSystem(marks, maxMarks, gradingSystemObj);
    }

    await result.update({
      marks: marks !== undefined ? marks : result.marks,
      isAbsent: isAbsent !== undefined ? isAbsent : result.isAbsent,
      remarks: remarks !== undefined ? remarks : result.remarks,
      description: description !== undefined ? description : result.description,
      grade: gradeInfo.grade,
      gradeCode: gradeInfo.code,
      points: gradeInfo.points
    });

    await createAuditLog(req, 'UPDATE', 'RESULT', result.id, oldResult, result);
    res.json({ success: true, result });
  } catch (error) {
    console.error('Update result error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/results/:id', authenticate, checkPermission('manage_results'), async (req, res) => {
  try {
    const result = await Result.findByPk(req.params.id);
    if (!result) {
      return res.status(404).json({ message: 'Result not found' });
    }

    const student = await Student.findByPk(result.studentId);
    if (student.schoolId !== req.user.schoolId && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ message: 'Access denied' });
    }

    await result.destroy();
    await createAuditLog(req, 'DELETE', 'RESULT', req.params.id);
    res.json({ success: true, message: 'Result deleted successfully' });
  } catch (error) {
    console.error('Delete result error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/results/positions', authenticate, checkPermission('manage_results'), async (req, res) => {
  try {
    const { examId } = req.body;

    const exam = await Exam.findOne({ where: { id: examId, schoolId: req.user.schoolId } });
    if (!exam) {
      return res.status(404).json({ message: 'Exam not found' });
    }

    const results = await Result.findAll({
      where: { examId },
      order: [['marks', 'DESC']]
    });

    let rank = 1;
    let prevMarks = null;
    for (let i = 0; i < results.length; i++) {
      if (prevMarks !== results[i].marks) {
        rank = i + 1;
        prevMarks = results[i].marks;
      }
      await results[i].update({ position: rank });
    }

    res.json({ success: true, message: `Positions updated for ${results.length} results` });
  } catch (error) {
    console.error('Calculate positions error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== ATTENDANCE ENDPOINTS ====================

// POST /api/attendance - Create or update attendance records
app.post('/api/attendance', authenticate, async (req, res) => {
  try {
    console.log('📝 Received attendance request body:', JSON.stringify(req.body, null, 2));
    
    // Get the attendance records from request
    let attendanceData = req.body;
    let attendanceRecords = [];
    
    // Handle different possible formats
    if (Array.isArray(attendanceData)) {
      attendanceRecords = attendanceData;
    } 
    else if (attendanceData && typeof attendanceData === 'object') {
      const keys = Object.keys(attendanceData);
      const hasNumericKeys = keys.some(key => !isNaN(key) && key !== '');
      
      if (hasNumericKeys) {
        attendanceRecords = keys
          .filter(key => !isNaN(key))
          .map(key => attendanceData[key]);
        console.log('📝 Converted object with numeric keys to array:', attendanceRecords);
      } else {
        attendanceRecords = [attendanceData];
        console.log('📝 Wrapped single object in array:', attendanceRecords);
      }
    }
    
    if (!attendanceRecords || attendanceRecords.length === 0) {
      return res.status(400).json({ 
        success: false,
        message: 'No attendance records provided' 
      });
    }
    
    console.log(`📝 Processing ${attendanceRecords.length} attendance records`);
    
    const createdRecords = [];
    const updatedRecords = [];
    const skippedRecords = []; // Records that already exist
    const errors = [];

    for (const record of attendanceRecords) {
      try {
        // Validate required fields
        if (!record.studentId || !record.status || !record.date) {
          errors.push({
            record,
            error: `Missing required fields for student ${record.studentId || 'unknown'}`
          });
          continue;
        }

        // Build where clause to check for existing record
        const whereClause = {
          studentId: record.studentId,
          date: record.date
        };
        
        // Add unitId or subjectId to where clause if provided
        if (record.unitId) {
          whereClause.unitId = record.unitId;
        } else if (record.subjectId) {
          whereClause.subjectId = record.subjectId;
        } else {
          whereClause.unitId = null;
          whereClause.subjectId = null;
        }

        // Check if attendance already exists
        const existingAttendance = await Attendance.findOne({ 
          where: whereClause,
          include: [
            { model: CourseUnit, as: 'unit', attributes: ['id', 'name'] },
            { model: Subject, attributes: ['id', 'name'] }
          ]
        });

        // Prepare attendance data
        const attendanceData = {
          studentId: record.studentId,
          status: record.status,
          date: record.date,
          remarks: record.remarks || '',
          markedBy: req.user.id,
          schoolId: req.user.schoolId,
          classId: record.classId || null,
          courseId: record.courseId || null,
          programId: record.programId || null,
          unitId: record.unitId || null,
          subjectId: record.subjectId || null,
          timetableId: record.timetableId || null,
          period: record.period || null,
          startTime: record.startTime || null,
          endTime: record.endTime || null,
          year: record.year || null,
          semester: record.semester || null,
          module: record.module || null
        };

        if (existingAttendance) {
          // Instead of automatically updating, return info about existing record
          console.log(`⚠️ Attendance already exists for student ${record.studentId}`);
          skippedRecords.push({
            id: existingAttendance.id,
            studentId: existingAttendance.studentId,
            date: existingAttendance.date,
            unitId: existingAttendance.unitId,
            unitName: existingAttendance.unit?.name || existingAttendance.Subject?.name || 'Unknown',
            status: existingAttendance.status,
            remarks: existingAttendance.remarks,
            message: 'Attendance already marked'
          });
        } else {
          // Create new record
          const attendance = await Attendance.create(attendanceData);
          createdRecords.push(attendance);
          console.log(`✅ Created attendance for student ${record.studentId}`);
        }
        
      } catch (err) {
        console.error('Error processing attendance record:', err);
        errors.push({
          record,
          error: err.message
        });
      }
    }

    // Return detailed response
    res.json({
      success: true,
      message: `Created ${createdRecords.length}, Already marked ${skippedRecords.length} attendance records`,
      summary: {
        created: createdRecords.length,
        updated: updatedRecords.length,
        skipped: skippedRecords.length,
        errors: errors.length
      },
      records: {
        created: createdRecords,
        skipped: skippedRecords // Return skipped records with details
      },
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    console.error('❌ Mark attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to mark attendance',
      error: error.message 
    });
  }
});
// GET /api/attendance - Get attendance records with filters
app.get('/api/attendance', authenticate, async (req, res) => {
  try {
    const { 
      studentId, classId, courseId, programId, unitId, subjectId,
      date, startDate, endDate, status, limit = 100, page = 1
    } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    
    // Apply filters
    if (studentId) where.studentId = studentId;
    if (classId) where.classId = classId;
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;
    if (unitId) where.unitId = unitId;
    if (subjectId) where.subjectId = subjectId;
    if (status) where.status = status;
    
    // Date filters
    if (date) {
      where.date = date;
    } else if (startDate && endDate) {
      where.date = {
        [Op.between]: [startDate, endDate]
      };
    }

    // Role-based access
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ where: { userId: req.user.id } });
      if (student) {
        where.studentId = student.id;
      } else {
        return res.json({ success: true, attendance: [], total: 0 });
      }
    } else if (req.user.role === 'PARENT') {
      const parents = await Parent.findAll({ 
        where: { userId: req.user.id },
        attributes: ['studentId']
      });
      const studentIds = parents.map(p => p.studentId);
      if (studentIds.length > 0) {
        where.studentId = studentIds;
      } else {
        return res.json({ success: true, attendance: [], total: 0 });
      }
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows } = await Attendance.findAndCountAll({
      where,
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          include: [
            { model: Course, attributes: ['id', 'name'], required: false },
            { model: Program, attributes: ['id', 'name'], required: false },
            { model: Class, attributes: ['id', 'name'], required: false }
          ]
        },
        { 
          model: CourseUnit, 
          as: 'unit',
          attributes: ['id', 'name', 'code', 'module'],
          required: false 
        },
        { 
          model: Subject, 
          attributes: ['id', 'name', 'code'],
          required: false 
        },
        { 
          model: Timetable, 
          attributes: ['id', 'period', 'startTime', 'endTime', 'room'],
          required: false 
        }
      ],
      order: [['date', 'DESC'], ['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: offset
    });
    
    res.json({ 
      success: true, 
      attendance: rows,
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / parseInt(limit))
    });
  } catch (error) {
    console.error('❌ Get attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});


// GET /api/attendance/report - Generate attendance report for a student
app.get('/api/attendance/report', authenticate, async (req, res) => {
  try {
    const { studentId, courseId, programId, startDate, endDate } = req.query;

    if (!studentId) {
      return res.status(400).json({ 
        success: false,
        message: 'Student ID is required' 
      });
    }

    // Check access
    let hasAccess = false;
    if (req.user.role === 'SUPER_ADMIN') {
      hasAccess = true;
    } else if (req.user.role === 'SCHOOL_ADMIN' || req.user.role === 'PRINCIPAL' || req.user.role === 'DEPUTY_PRINCIPAL' || req.user.role === 'SENIOR_TEACHER') {
      const student = await Student.findOne({
        where: { 
          id: studentId, 
          schoolId: req.user.schoolId 
        }
      });
      hasAccess = !!student;
    } else if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ 
        where: { userId: req.user.id } 
      });
      hasAccess = student && student.id === studentId;
    } else if (req.user.role === 'PARENT') {
      const parent = await Parent.findOne({
        where: { 
          userId: req.user.id, 
          studentId: studentId 
        }
      });
      hasAccess = !!parent;
    }

    if (!hasAccess) {
      return res.status(403).json({ 
        success: false,
        message: 'Access denied' 
      });
    }

    const student = await Student.findByPk(studentId, {
      attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
      include: [
        { model: Course, required: false },
        { model: Program, required: false },
        { model: Class, required: false }
      ]
    });

    if (!student) {
      return res.status(404).json({ 
        success: false,
        message: 'Student not found' 
      });
    }

    const where = { studentId };
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;

    const attendance = await Attendance.findAll({
      where,
      include: [
        { 
          model: CourseUnit, 
          as: 'unit',
          attributes: ['id', 'name', 'code', 'module'],
          required: false 
        },
        { 
          model: Subject, 
          attributes: ['id', 'name', 'code'],
          required: false 
        },
        { 
          model: Timetable, 
          attributes: ['id', 'period', 'startTime', 'endTime'],
          required: false 
        }
      ],
      order: [['date', 'DESC']]
    });

    // Overall summary
    const overall = {
      total: attendance.length,
      present: attendance.filter(a => a.status === 'PRESENT').length,
      absent: attendance.filter(a => a.status === 'ABSENT').length,
      late: attendance.filter(a => a.status === 'LATE').length,
      permission: attendance.filter(a => a.status === 'PERMISSION').length,
      sick: attendance.filter(a => a.status === 'SICK').length,
      fieldTrip: attendance.filter(a => a.status === 'FIELD_TRIP').length,
      presentPercentage: attendance.length > 0 
        ? ((attendance.filter(a => a.status === 'PRESENT').length / attendance.length) * 100).toFixed(2)
        : 0
    };

    // Group by unit/subject
    const byCourse = {};
    attendance.forEach(record => {
      const courseId = record.unitId || record.subjectId || 'no-course';
      const courseName = record.unit?.name || record.Subject?.name || 'No Course';
      
      if (!byCourse[courseId]) {
        byCourse[courseId] = {
          courseId,
          courseName,
          total: 0,
          present: 0,
          absent: 0,
          late: 0,
          permission: 0,
          sick: 0,
          fieldTrip: 0,
          records: []
        };
      }
      
      byCourse[courseId].total++;
      byCourse[courseId][record.status.toLowerCase()]++;
      byCourse[courseId].records.push(record);
    });

    // Calculate percentages per course
    Object.values(byCourse).forEach(course => {
      course.presentPercentage = course.total > 0 
        ? ((course.present / course.total) * 100).toFixed(2) 
        : 0;
      course.absentPercentage = course.total > 0 
        ? ((course.absent / course.total) * 100).toFixed(2) 
        : 0;
      course.latePercentage = course.total > 0 
        ? ((course.late / course.total) * 100).toFixed(2) 
        : 0;
    });

    res.json({
      success: true,
      report: {
        student,
        overall,
        byCourse: Object.values(byCourse),
        records: attendance
      }
    });
  } catch (error) {
    console.error('❌ Get attendance report error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET /api/attendance/by-admission/:admissionNumber - Get student attendance by admission number
app.get('/api/attendance/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { startDate, endDate, limit = 100 } = req.query;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      },
      include: [
        { model: Course, required: false },
        { model: Program, required: false },
        { model: Class, required: false }
      ]
    });

    if (!student) {
      return res.status(404).json({ 
        success: false,
        message: 'Student not found with this admission number' 
      });
    }

    const where = { studentId: student.id };
    
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    const attendance = await Attendance.findAll({
      where,
      include: [
        { 
          model: CourseUnit, 
          as: 'unit',
          attributes: ['id', 'name', 'code', 'module'],
          required: false 
        },
        { 
          model: Subject, 
          attributes: ['id', 'name', 'code'],
          required: false 
        },
        { 
          model: Timetable, 
          attributes: ['id', 'period', 'startTime', 'endTime', 'room'],
          required: false 
        }
      ],
      order: [['date', 'DESC'], ['createdAt', 'DESC']],
      limit: parseInt(limit)
    });

    // Calculate summary statistics
    const summary = {
      total: attendance.length,
      present: attendance.filter(a => a.status === 'PRESENT').length,
      absent: attendance.filter(a => a.status === 'ABSENT').length,
      late: attendance.filter(a => a.status === 'LATE').length,
      permission: attendance.filter(a => a.status === 'PERMISSION').length,
      sick: attendance.filter(a => a.status === 'SICK').length,
      fieldTrip: attendance.filter(a => a.status === 'FIELD_TRIP').length,
      presentPercentage: attendance.length > 0 
        ? ((attendance.filter(a => a.status === 'PRESENT').length / attendance.length) * 100).toFixed(2)
        : 0
    };

    // Group by unit for detailed stats
    const byUnit = {};
    attendance.forEach(record => {
      const unitId = record.unitId || record.subjectId;
      if (!unitId) return;
      
      const unitName = record.unit?.name || record.Subject?.name || 'Unknown';
      
      if (!byUnit[unitId]) {
        byUnit[unitId] = {
          unitId,
          unitName,
          total: 0,
          present: 0,
          absent: 0,
          late: 0
        };
      }
      
      byUnit[unitId].total++;
      byUnit[unitId][record.status.toLowerCase()]++;
    });

    // Calculate percentages per unit
    Object.values(byUnit).forEach(unit => {
      unit.presentPercentage = unit.total > 0 
        ? ((unit.present / unit.total) * 100).toFixed(1) 
        : 0;
    });

    res.json({ 
      success: true, 
      attendance,
      summary,
      byUnit: Object.values(byUnit),
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber,
        course: student.Course,
        program: student.Program,
        class: student.Class
      }
    });
  } catch (error) {
    console.error('❌ Get attendance by admission error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error',
      error: error.message 
    });
  }
});

// GET /api/attendance/stats - Get attendance statistics
app.get('/api/attendance/stats', authenticate, async (req, res) => {
  try {
    const { courseId, programId, startDate, endDate } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    const attendance = await Attendance.findAll({
      where,
      include: [
        { model: Student, attributes: ['id'] },
        { model: CourseUnit, as: 'unit', attributes: ['id', 'name'], required: false },
        { model: Subject, attributes: ['id', 'name'], required: false }
      ]
    });

    // Daily statistics
    const dailyStats = {};
    attendance.forEach(record => {
      if (!dailyStats[record.date]) {
        dailyStats[record.date] = {
          date: record.date,
          total: 0,
          present: 0,
          absent: 0,
          late: 0,
          permission: 0,
          sick: 0,
          fieldTrip: 0
        };
      }
      dailyStats[record.date].total++;
      dailyStats[record.date][record.status.toLowerCase()]++;
    });

    // Calculate daily percentages
    Object.values(dailyStats).forEach(day => {
      day.presentPercentage = day.total > 0 
        ? ((day.present / day.total) * 100).toFixed(2) 
        : 0;
    });

    // Unit/Subject statistics
    const unitStats = {};
    attendance.forEach(record => {
      const unitId = record.unitId || record.subjectId;
      if (!unitId) return;
      
      const unitName = record.unit?.name || record.Subject?.name || 'Unknown';
      
      if (!unitStats[unitId]) {
        unitStats[unitId] = {
          unitId,
          unitName,
          total: 0,
          present: 0,
          absent: 0,
          late: 0
        };
      }
      
      unitStats[unitId].total++;
      unitStats[unitId][record.status.toLowerCase()]++;
    });

    // Calculate unit percentages
    Object.values(unitStats).forEach(unit => {
      unit.presentPercentage = unit.total > 0 
        ? ((unit.present / unit.total) * 100).toFixed(2) 
        : 0;
    });

    res.json({
      success: true,
      stats: {
        daily: Object.values(dailyStats),
        byUnit: Object.values(unitStats),
        summary: {
          totalRecords: attendance.length,
          uniqueStudents: [...new Set(attendance.map(a => a.studentId))].length,
          uniqueDates: Object.keys(dailyStats).length,
          uniqueUnits: Object.keys(unitStats).length
        }
      }
    });
  } catch (error) {
    console.error('❌ Get attendance stats error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ❌ GENERIC ROUTES LAST - THESE COME AFTER ALL SPECIFIC ROUTES

// GET /api/attendance/:id - Get single attendance record
app.get('/api/attendance/:id', authenticate, async (req, res) => {
  try {
    const attendance = await Attendance.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] 
        },
        { model: CourseUnit, as: 'unit', required: false },
        { model: Subject, required: false },
        { model: Timetable, required: false }
      ]
    });
    
    if (!attendance) {
      return res.status(404).json({ 
        success: false,
        message: 'Attendance record not found' 
      });
    }
    
    res.json({ 
      success: true, 
      attendance 
    });
  } catch (error) {
    console.error('❌ Get attendance record error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// PUT /api/attendance/:id - Update attendance record
app.put('/api/attendance/:id', authenticate, async (req, res) => {
  try {
    const attendance = await Attendance.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!attendance) {
      return res.status(404).json({ 
        success: false,
        message: 'Attendance record not found' 
      });
    }

    const oldAttendance = { ...attendance.toJSON() };
    await attendance.update(req.body);
    
    // Create audit log
    await createAuditLog(req, 'UPDATE', 'ATTENDANCE', attendance.id, oldAttendance, attendance);

    const updatedAttendance = await Attendance.findByPk(attendance.id, {
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: CourseUnit, as: 'unit', required: false },
        { model: Subject, required: false }
      ]
    });

    res.json({ 
      success: true, 
      attendance: updatedAttendance 
    });
  } catch (error) {
    console.error('❌ Update attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE /api/attendance/:id - Delete attendance record
app.delete('/api/attendance/:id', authenticate, async (req, res) => {
  try {
    const attendance = await Attendance.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!attendance) {
      return res.status(404).json({ 
        success: false,
        message: 'Attendance record not found' 
      });
    }

    await attendance.destroy();
    
    // Create audit log
    await createAuditLog(req, 'DELETE', 'ATTENDANCE', req.params.id);

    res.json({ 
      success: true, 
      message: 'Attendance record deleted successfully' 
    });
  } catch (error) {
    console.error('❌ Delete attendance error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error', 
      error: error.message 
    });
  }
});


// ==================== GET ALL FEES ====================
app.get('/api/fees', authenticate, async (req, res) => {
  try {
    const { classId, courseId, programId, year, term } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Build where clause based on school type
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
      if (year) where.year = year;
    } else if (school.category === 'COLLEGE_TVET') {
      if (programId) where.programId = programId;
    } else {
      if (classId) where.classId = classId;
    }
    
    if (term) where.term = term;

    const fees = await Fee.findAll({
      where,
      include: [
        { model: Class, required: false },
        { model: Course, required: false },
        { model: Program, required: false },
        { model: Faculty, required: false },
        { model: Department, required: false },
        { model: TransportRoute, required: false }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, fees });
  } catch (error) {
    console.error('Get fees error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== GET SINGLE FEE ====================
app.get('/api/fees/:id', authenticate, async (req, res) => {
  try {
    const fee = await Fee.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [
        { model: Class, required: false },
        { model: Course, required: false },
        { model: Program, required: false },
        { model: Faculty, required: false },
        { model: Department, required: false },
        { model: TransportRoute, required: false }
      ]
    });
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }
    
    res.json({ success: true, fee });
  } catch (error) {
    console.error('Get fee error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== CREATE FEE ====================
app.post('/api/fees', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const feeData = { ...req.body, schoolId: req.user.schoolId };
    
    // Clean up empty UUID fields
    const uuidFields = ['classId', 'courseId', 'facultyId', 'departmentId', 'programId', 'moduleId', 'transportRouteId'];
    uuidFields.forEach(field => {
      if (feeData[field] === '') feeData[field] = null;
    });

    // Convert string numbers to proper types
    if (feeData.amount) feeData.amount = parseFloat(feeData.amount);
    if (feeData.year) feeData.year = parseInt(feeData.year);
    if (feeData.semester) feeData.semester = parseInt(feeData.semester);
    if (feeData.module) feeData.module = parseInt(feeData.module);

    const fee = await Fee.create(feeData);
    
    // Create audit log
    await createAuditLog(req, 'CREATE', 'FEE', fee.id, null, fee);
    
    // Fetch with associations
    const createdFee = await Fee.findByPk(fee.id, {
      include: [
        { model: Class, required: false },
        { model: Course, required: false },
        { model: Program, required: false }
      ]
    });
    
    res.status(201).json({ success: true, fee: createdFee });
  } catch (error) {
    console.error('Create fee error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== UPDATE FEE ====================
app.put('/api/fees/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const fee = await Fee.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }

    const updateData = { ...req.body };
    
    // Clean up empty UUID fields
    const uuidFields = ['classId', 'courseId', 'facultyId', 'departmentId', 'programId', 'moduleId', 'transportRouteId'];
    uuidFields.forEach(field => {
      if (updateData[field] === '') updateData[field] = null;
    });

    // Convert string numbers to proper types
    if (updateData.amount) updateData.amount = parseFloat(updateData.amount);
    if (updateData.year) updateData.year = parseInt(updateData.year);
    if (updateData.semester) updateData.semester = parseInt(updateData.semester);
    if (updateData.module) updateData.module = parseInt(updateData.module);

    const oldFee = { ...fee.toJSON() };
    await fee.update(updateData);
    
    // Create audit log
    await createAuditLog(req, 'UPDATE', 'FEE', fee.id, oldFee, fee);
    
    // Fetch updated fee with associations
    const updatedFee = await Fee.findByPk(fee.id, {
      include: [
        { model: Class, required: false },
        { model: Course, required: false },
        { model: Program, required: false }
      ]
    });

    res.json({ success: true, fee: updatedFee });
  } catch (error) {
    console.error('Update fee error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== DELETE FEE ====================
app.delete('/api/fees/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const fee = await Fee.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      }
    });
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }

    // Check if there are any payments associated with this fee
    const paymentsCount = await Payment.count({
      where: { feeId: fee.id }
    });

    if (paymentsCount > 0) {
      // Option 1: Prevent deletion if payments exist
      // return res.status(400).json({ 
      //   success: false, 
      //   message: `Cannot delete fee with ${paymentsCount} payment(s) associated. Delete payments first.` 
      // });
      
      // Option 2: Allow deletion and log warning
      console.log(`⚠️ Deleting fee with ${paymentsCount} associated payments`);
    }

    await fee.destroy();
    
    // Create audit log
    await createAuditLog(req, 'DELETE', 'FEE', req.params.id, null, { 
      hadPayments: paymentsCount > 0,
      paymentsCount 
    });

    res.json({ 
      success: true, 
      message: 'Fee deleted successfully',
      paymentsAffected: paymentsCount
    });
  } catch (error) {
    console.error('Delete fee error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== AUTO-ALLOCATE FEE ====================
app.post('/api/fees/:id/auto-allocate', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const fee = await Fee.findByPk(req.params.id);
    
    if (!fee) {
      return res.status(404).json({ 
        success: false, 
        message: 'Fee not found' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    // Find students who should get this fee
    let where = { schoolId: req.user.schoolId, isActive: true };
    
    if (school.category === 'UNIVERSITY') {
      if (fee.courseId) where.courseId = fee.courseId;
      if (fee.year) where.currentYear = fee.year;
    } else if (school.category === 'COLLEGE_TVET') {
      if (fee.programId) where.programId = fee.programId;
      if (fee.module) where.currentModule = `Module ${fee.module}`;
    } else {
      if (fee.classId) where.classId = fee.classId;
    }

    const students = await Student.findAll({ where });
    
    let allocated = 0;
    let skipped = 0;
    
    for (const student of students) {
      // Check if student already has this fee
      const existing = await Payment.findOne({
        where: { 
          studentId: student.id, 
          feeId: fee.id 
        }
      });
      
      if (!existing) {
        // Create a pending payment record (amount 0 means allocated but not paid)
        await Payment.create({
          studentId: student.id,
          feeId: fee.id,
          amount: 0,
          status: 'PENDING',
          schoolId: req.user.schoolId,
          notes: `Auto-allocated on ${new Date().toLocaleDateString()}`
        });
        allocated++;
      } else {
        skipped++;
      }
    }

    // Create audit log
    await createAuditLog(req, 'AUTO_ALLOCATE', 'FEE', fee.id, null, { 
      allocated, 
      skipped,
      totalStudents: students.length 
    });

    res.json({ 
      success: true, 
      message: `Fee auto-allocated to ${allocated} students (${skipped} already had it)`,
      allocated,
      skipped
    });
  } catch (error) {
    console.error('Auto-allocate error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// In your backend server.cjs - Update the POST /api/payments route

app.post('/api/payments', authenticate, async (req, res) => {
  try {
    const { 
      studentId, feeId, amount, paymentMethod, transactionId, notes,
      mpesaCode, mpesaPhone, bankReference, bankMessage,
      cardLast4, cardApprovalCode, chequeNumber, chequeBank,
      isOtherIncome, incomeCategory, description, payer,
      // NEW FIELDS
      studentName, admissionNumber, courseName, className, feeName
    } = req.body;

    // Validate required fields
    if (!amount || amount <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Valid amount is required' 
      });
    }

    if (!studentId && !isOtherIncome) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student ID is required for fee payments' 
      });
    }

    // Generate receipt number
    const receiptNo = await generateReceiptNo();

    // If this is a fee payment, verify the student exists
    if (!isOtherIncome && studentId) {
      const student = await Student.findOne({
        where: { 
          id: studentId, 
          schoolId: req.user.schoolId 
        }
      });
      
      if (!student) {
        return res.status(404).json({ 
          success: false, 
          message: 'Student not found in your school' 
        });
      }
    }

    // Create the payment with ALL fields
    const payment = await Payment.create({
      studentId: isOtherIncome ? null : studentId,
      feeId: feeId || null,
      amount,
      paymentMethod: paymentMethod || 'CASH',
      transactionId: transactionId || null,
      receiptNo,
      notes: notes || null,
      recordedBy: req.user.id,
      schoolId: req.user.schoolId,
      
      // Payment method specific fields
      mpesaCode: mpesaCode || null,
      mpesaPhone: mpesaPhone || null,
      bankReference: bankReference || null,
      bankMessage: bankMessage || null,
      cardLast4: cardLast4 || null,
      cardApprovalCode: cardApprovalCode || null,
      chequeNumber: chequeNumber || null,
      chequeBank: chequeBank || null,
      
      paymentDate: new Date(),
      isOtherIncome: isOtherIncome || false,
      incomeCategory: incomeCategory || null,
      description: description || null,
      payer: payer || null,
      
      // NEW FIELDS for receipt history
      studentName: studentName || null,
      admissionNumber: admissionNumber || null,
      courseName: courseName || null,
      className: className || null,
      feeName: feeName || null
    });

    await createAuditLog(req, 'RECORD', 'PAYMENT', payment.id, null, payment);

    // Fetch the created payment with associations
    const createdPayment = await Payment.findByPk(payment.id, {
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        },
        { 
          model: Fee, 
          attributes: ['id', 'name', 'amount'],
          required: false 
        }
      ]
    });

    res.status(201).json({ 
      success: true, 
      payment: createdPayment,
      message: 'Payment recorded successfully' 
    });
  } catch (error) {
    console.error('❌ Record payment error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/payments', authenticate, async (req, res) => {
  try {
    const { studentId, startDate, endDate, isOtherIncome } = req.query;
    
    let where = { schoolId: req.user.schoolId };
    
    // Handle studentId filter
    if (studentId) {
      // Check if user has access to this student
      if (req.user.role === 'PARENT') {
        const parent = await Parent.findOne({
          where: { 
            userId: req.user.id, 
            studentId: studentId 
          }
        });
        if (!parent) {
          return res.status(403).json({ 
            success: false, 
            message: 'You do not have access to this student\'s payments' 
          });
        }
      } else if (req.user.role === 'STUDENT') {
        const student = await Student.findOne({
          where: { userId: req.user.id }
        });
        if (!student || student.id !== studentId) {
          return res.status(403).json({ 
            success: false, 
            message: 'You can only view your own payments' 
          });
        }
      }
      where.studentId = studentId;
    }
    
    // Handle other income filter
    if (isOtherIncome !== undefined) {
      where.isOtherIncome = isOtherIncome === 'true';
    }
    
    // Handle date range
    if (startDate && endDate) {
      where.createdAt = {
        [Op.between]: [new Date(startDate), new Date(endDate)]
      };
    }

    // For non-admin roles, restrict access
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ 
        where: { userId: req.user.id } 
      });
      if (student) {
        where.studentId = student.id;
      } else {
        return res.json({ success: true, payments: [] });
      }
    } else if (req.user.role === 'PARENT') {
      const parents = await Parent.findAll({ 
        where: { userId: req.user.id },
        attributes: ['studentId']
      });
      const studentIds = parents.map(p => p.studentId);
      if (studentIds.length > 0) {
        where.studentId = studentIds;
      } else {
        return res.json({ success: true, payments: [] });
      }
    }

    const payments = await Payment.findAll({
      where,
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        },
        { 
          model: Fee, 
          attributes: ['id', 'name', 'amount'],
          required: false 
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ 
      success: true, 
      payments,
      count: payments.length 
    });
  } catch (error) {
    console.error('❌ Get payments error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/payments/:id', authenticate, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        },
        { 
          model: Fee, 
          attributes: ['id', 'name', 'amount'],
          required: false 
        }
      ]
    });

    if (!payment) {
      return res.status(404).json({ 
        success: false, 
        message: 'Payment not found' 
      });
    }

    // Check access for non-admin users
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ 
        where: { userId: req.user.id } 
      });
      if (!student || payment.studentId !== student.id) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    } else if (req.user.role === 'PARENT') {
      const parent = await Parent.findOne({
        where: { 
          userId: req.user.id, 
          studentId: payment.studentId 
        }
      });
      if (!parent) {
        return res.status(403).json({ 
          success: false, 
          message: 'Access denied' 
        });
      }
    }

    res.json({ 
      success: true, 
      payment 
    });
  } catch (error) {
    console.error('❌ Get payment error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/students/:studentId/fee-statement', authenticate, async (req, res) => {
  try {
    const studentId = req.params.studentId;

    // Check access
    let hasAccess = false;
    if (req.user.role === 'SUPER_ADMIN') {
      hasAccess = true;
    } else if (req.user.role === 'SCHOOL_ADMIN' || req.user.role === 'PRINCIPAL' || req.user.role === 'ACCOUNTANT') {
      const student = await Student.findOne({
        where: { 
          id: studentId, 
          schoolId: req.user.schoolId 
        }
      });
      hasAccess = !!student;
    } else if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ 
        where: { userId: req.user.id } 
      });
      hasAccess = student && student.id === studentId;
    } else if (req.user.role === 'PARENT') {
      const parent = await Parent.findOne({
        where: { 
          userId: req.user.id, 
          studentId: studentId 
        }
      });
      hasAccess = !!parent;
    }

    if (!hasAccess) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied' 
      });
    }

    const student = await Student.findOne({
      where: { 
        id: studentId,
        schoolId: req.user.schoolId 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found' 
      });
    }

    const school = await School.findByPk(req.user.schoolId);
    
    // Get applicable fees
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      if (student.courseId) feeWhere.courseId = student.courseId;
      if (student.currentYear) feeWhere.year = student.currentYear;
    } else if (school.category === 'COLLEGE_TVET') {
      if (student.programId) feeWhere.programId = student.programId;
    } else {
      if (student.classId) feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });

    // Get payments
    const payments = await Payment.findAll({
      where: { 
        studentId, 
        isOtherIncome: false 
      },
      include: [{ model: Fee }],
      order: [['createdAt', 'DESC']]
    });

    const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount || 0), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const balance = totalFees - totalPaid;

    res.json({
      success: true,
      statement: {
        student: {
          id: student.id,
          firstName: student.firstName,
          lastName: student.lastName,
          admissionNumber: student.admissionNumber,
          classId: student.classId,
          courseId: student.courseId
        },
        fees,
        payments,
        summary: {
          totalFees,
          totalPaid,
          balance
        }
      }
    });
  } catch (error) {
    console.error('❌ Get fee statement error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.get('/api/students/:studentId/fee-statement', authenticate, async (req, res) => {
  try {
    const studentId = req.params.studentId;

    if (!await checkStudentAccess(studentId, req.user)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const student = await Student.findByPk(studentId);
    const school = await School.findByPk(req.user.schoolId);
    
    let feeWhere = { schoolId: req.user.schoolId };
    if (school.category === 'UNIVERSITY') {
      feeWhere.courseId = student.courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      feeWhere.programId = student.programId;
    } else {
      feeWhere.classId = student.classId;
    }

    const fees = await Fee.findAll({ where: feeWhere });

    const payments = await Payment.findAll({
      where: { studentId },
      include: [{ model: Fee }]
    });

    const totalFees = fees.reduce((sum, fee) => sum + parseFloat(fee.amount), 0);
    const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const balance = totalFees - totalPaid;

    res.json({
      success: true,
      statement: {
        student,
        fees,
        payments,
        summary: {
          totalFees,
          totalPaid,
          balance
        }
      }
    });
  } catch (error) {
    console.error('Get fee statement error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== EXPENSE ROUTES ====================

app.post('/api/expenses', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { category, description, amount, date, paymentMethod, vendor, notes } = req.body;

    const expense = await Expense.create({
      category,
      description,
      amount,
      date,
      paymentMethod,
      vendor,
      notes,
      schoolId: req.user.schoolId,
      approvedBy: req.user.id
    });

    await createAuditLog(req, 'CREATE', 'EXPENSE', expense.id, null, expense);

    res.status(201).json({ success: true, expense });
  } catch (error) {
    console.error('Create expense error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/expenses', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, category } = req.query;
    const where = { schoolId: req.user.schoolId };

    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    if (category) where.category = category;

    const expenses = await Expense.findAll({
      where,
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, expenses });
  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== STAFF ROUTES ====================

app.post('/api/staff', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      userId, employeeId, tscNumber, department, jobTitle,
      employmentDate, qualifications, specialization, subjects,
      bankDetails, deductions, salary, staffType
    } = req.body;

    const schoolId = req.user.schoolId;

    if (!schoolId) {
      return res.status(400).json({ message: 'No school associated with user' });
    }

    if (!employmentDate) {
      return res.status(400).json({ message: 'Employment date is required' });
    }

    const parsedDate = new Date(employmentDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ message: 'Invalid employment date format' });
    }

    const existing = await Staff.findOne({ 
      where: { 
        userId,
        schoolId 
      } 
    });
    
    if (existing) {
      return res.status(400).json({ message: 'Staff profile already exists for this user' });
    }

    const staff = await Staff.create({
      userId,
      employeeId,
      tscNumber,
      department,
      jobTitle,
      employmentDate: parsedDate,
      qualifications: qualifications || [],
      specialization: specialization || '',
      subjects: subjects || [],
      bankDetails: bankDetails || { bank: '', branch: '', account: '' },
      deductions: deductions || { nhif: 0, nssf: 0, sacco: 0, helb: 0 },
      salary: salary || { basic: 0, house: 0, transport: 0 },
      staffType: staffType || 'TEACHING',
      schoolId: schoolId
    });

    await createAuditLog(req, 'CREATE', 'STAFF', staff.id, null, staff);

    res.status(201).json({ success: true, staff });
  } catch (error) {
    console.error('Create staff error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/staff', authenticate, async (req, res) => {
  try {
    const staff = await Staff.findAll({
      where: { 
        schoolId: req.user.schoolId
      },
      include: [{ 
        model: User, 
        attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] 
      }]
    });
    
    res.json({ success: true, staff });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/staff/:id', authenticate, async (req, res) => {
  try {
    const staff = await Staff.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [{ 
        model: User, 
        attributes: ['id', 'firstName', 'lastName', 'email', 'phone'] 
      }]
    });
    
    if (!staff) {
      return res.status(404).json({ message: 'Staff member not found' });
    }
    
    res.json({ success: true, staff });
  } catch (error) {
    console.error('Get staff error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.put('/api/staff/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const staff = await Staff.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!staff) return res.status(404).json({ message: 'Staff not found' });

    const oldStaff = { ...staff.toJSON() };
    await staff.update(req.body);
    await createAuditLog(req, 'UPDATE', 'STAFF', staff.id, oldStaff, staff);

    res.json({ success: true, staff });
  } catch (error) {
    console.error('Update staff error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/staff/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const staff = await Staff.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!staff) return res.status(404).json({ message: 'Staff not found' });

    await staff.destroy();
    await createAuditLog(req, 'DELETE', 'STAFF', req.params.id);

    res.json({ success: true, message: 'Staff deleted successfully' });
  } catch (error) {
    console.error('Delete staff error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== PAYROLL ROUTES ====================

app.post('/api/payroll/process', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { month, year } = req.body;

    const staff = await Staff.findAll({
      where: { schoolId: req.user.schoolId },
      include: [{ model: User }]
    });

    const payrolls = [];

    for (const s of staff) {
      const grossPay = calculateGross(s.salary);
      const deductions = calculateDeductions(s.deductions);
      const netPay = grossPay - deductions;

      const payroll = await Payroll.create({
        staffId: s.id,
        month,
        year,
        grossPay,
        deductions,
        netPay,
        status: 'PENDING'
      });

      await Expense.create({
        category: 'Salaries & Wages',
        description: `Salary for ${s.User.firstName} ${s.User.lastName} - ${month}/${year}`,
        amount: netPay,
        date: new Date(),
        paymentMethod: 'BANK',
        schoolId: req.user.schoolId
      });

      if (deductions > 0) {
        await Expense.create({
          category: 'Statutory Deductions',
          description: `NHIF/NSSF for ${s.User.firstName} ${s.User.lastName} - ${month}/${year}`,
          amount: deductions,
          date: new Date(),
          paymentMethod: 'BANK',
          schoolId: req.user.schoolId
        });
      }

      payrolls.push(payroll);
    }

    res.status(201).json({ 
      success: true, 
      payrolls,
      message: `Payroll processed. School account will be debited KES ${payrolls.reduce((sum, p) => sum + p.netPay + p.deductions, 0)}`
    });
  } catch (error) {
    console.error('Process payroll error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/payroll', authenticate, async (req, res) => {
  try {
    const { month, year, staffId } = req.query;
    const where = {};

    if (month) where.month = month;
    if (year) where.year = year;
    if (staffId) where.staffId = staffId;

    const payrolls = await Payroll.findAll({
      where,
      include: [{ model: Staff, include: [{ model: User }] }],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, payrolls });
  } catch (error) {
    console.error('Get payroll error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/payroll/:id/pay', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const payroll = await Payroll.findByPk(req.params.id);
    if (!payroll) return res.status(404).json({ message: 'Payroll not found' });

    await payroll.update({
      status: 'PAID',
      paymentDate: new Date()
    });

    await createAuditLog(req, 'PAY', 'PAYROLL', payroll.id, null, { status: 'PAID' });

    res.json({ success: true, payroll });
  } catch (error) {
    console.error('Pay payroll error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== LIBRARY ROUTES ====================

app.post('/api/books', authenticate, async (req, res) => {
  try {
    const {
      title, author, isbn, publisher, year,
      category, quantity, location, shelf
    } = req.body;

    const book = await Book.create({
      title,
      author,
      isbn,
      publisher,
      year,
      category,
      quantity,
      available: quantity,
      location,
      shelf,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'BOOK', book.id, null, book);

    res.status(201).json({ success: true, book });
  } catch (error) {
    console.error('Create book error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/books', authenticate, async (req, res) => {
  try {
    const { search, category } = req.query;
    const where = { schoolId: req.user.schoolId };

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { author: { [Op.iLike]: `%${search}%` } },
        { isbn: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (category) where.category = category;

    const books = await Book.findAll({ where });
    
    res.json({ success: true, books });
  } catch (error) {
    console.error('Get books error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/books/borrow', authenticate, async (req, res) => {
  try {
    const { bookId, studentId, dueDate } = req.body;

    const book = await Book.findByPk(bookId);
    if (!book || book.available < 1) {
      return res.status(400).json({ message: 'Book not available' });
    }

    const borrow = await Borrow.create({
      bookId,
      studentId,
      borrowDate: new Date(),
      dueDate,
      status: 'BORROWED'
    });

    await book.update({ available: book.available - 1 });

    await createAuditLog(req, 'BORROW', 'BOOK', bookId, null, borrow);

    res.status(201).json({ success: true, borrow });
  } catch (error) {
    console.error('Borrow book error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/books/return/:id', authenticate, async (req, res) => {
  try {
    const borrow = await Borrow.findByPk(req.params.id);
    
    if (!borrow) return res.status(404).json({ message: 'Borrow record not found' });

    let fine = 0;
    const today = new Date();
    const dueDate = new Date(borrow.dueDate);
    
    if (today > dueDate) {
      const daysOverdue = Math.ceil((today - dueDate) / (1000 * 60 * 60 * 24));
      fine = daysOverdue * 10;
    }

    await borrow.update({
      returnDate: today,
      status: 'RETURNED',
      fine
    });

    await Book.update(
      { available: sequelize.literal('available + 1') },
      { where: { id: borrow.bookId } }
    );

    await createAuditLog(req, 'RETURN', 'BOOK', borrow.bookId, null, borrow);

    res.json({ 
      success: true, 
      borrow,
      fine,
      message: fine > 0 ? `Book returned with fine of KES ${fine}` : 'Book returned successfully'
    });
  } catch (error) {
    console.error('Return book error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/books/borrowed', authenticate, async (req, res) => {
  try {
    const { studentId } = req.query;
    const where = { status: 'BORROWED' };
    
    if (studentId) where.studentId = studentId;

    const borrows = await Borrow.findAll({
      where,
      include: [
        { model: Book, required: false },
        { model: Student, required: false }
      ],
      order: [['dueDate', 'ASC']]
    });

    res.json({ success: true, borrows });
  } catch (error) {
    console.error('Get borrowed books error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== COMPLETE LIBRARY ROUTES ====================

// GET single book by ID
app.get('/api/books/:id', authenticate, async (req, res) => {
  try {
    const book = await Book.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!book) {
      return res.status(404).json({ 
        success: false, 
        message: 'Book not found' 
      });
    }
    
    res.json({ success: true, book });
  } catch (error) {
    console.error('Get book error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPDATE book
app.put('/api/books/:id', authenticate, async (req, res) => {
  try {
    const book = await Book.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!book) {
      return res.status(404).json({ 
        success: false, 
        message: 'Book not found' 
      });
    }

    const {
      title, author, isbn, publisher, year,
      category, quantity, location, shelf
    } = req.body;

    // Calculate new available count based on quantity change
    const quantityDiff = quantity - book.quantity;
    const newAvailable = book.available + quantityDiff;

    // Ensure available doesn't go negative
    if (newAvailable < 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot reduce quantity below currently borrowed books' 
      });
    }

    const oldBook = { ...book.toJSON() };
    
    await book.update({
      title,
      author,
      isbn,
      publisher,
      year,
      category,
      quantity,
      available: newAvailable,
      location,
      shelf
    });

    await createAuditLog(req, 'UPDATE', 'BOOK', book.id, oldBook, book);

    res.json({ 
      success: true, 
      book,
      message: 'Book updated successfully' 
    });
  } catch (error) {
    console.error('Update book error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE book
app.delete('/api/books/:id', authenticate, async (req, res) => {
  try {
    const book = await Book.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!book) {
      return res.status(404).json({ 
        success: false, 
        message: 'Book not found' 
      });
    }

    // Check if book is currently borrowed
    const activeBorrows = await Borrow.count({
      where: { 
        bookId: book.id, 
        status: 'BORROWED' 
      }
    });

    if (activeBorrows > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete book with ${activeBorrows} active borrow(s). Please return all copies first.` 
      });
    }

    await book.destroy();
    await createAuditLog(req, 'DELETE', 'BOOK', req.params.id);

    res.json({ 
      success: true, 
      message: 'Book deleted successfully' 
    });
  } catch (error) {
    console.error('Delete book error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET all borrows (with optional filters)
app.get('/api/borrows', authenticate, async (req, res) => {
  try {
    const { 
      studentId, bookId, status, 
      startDate, endDate, 
      limit = 100, page = 1 
    } = req.query;
    
    const where = {};
    
    if (studentId) where.studentId = studentId;
    if (bookId) where.bookId = bookId;
    if (status) where.status = status;
    
    if (startDate && endDate) {
      where.borrowDate = {
        [Op.between]: [startDate, endDate]
      };
    }

    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { count, rows } = await Borrow.findAndCountAll({
      where,
      include: [
        { 
          model: Book,
          where: { schoolId: req.user.schoolId },
          required: true
        },
        { 
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false
        }
      ],
      order: [['borrowDate', 'DESC']],
      limit: parseInt(limit),
      offset: offset
    });

    res.json({ 
      success: true, 
      borrows: rows,
      total: count,
      page: parseInt(page),
      totalPages: Math.ceil(count / parseInt(limit))
    });
  } catch (error) {
    console.error('Get borrows error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET single borrow by ID
app.get('/api/borrows/:id', authenticate, async (req, res) => {
  try {
    const borrow = await Borrow.findOne({
      where: { id: req.params.id },
      include: [
        { 
          model: Book,
          where: { schoolId: req.user.schoolId },
          required: true
        },
        { 
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
        }
      ]
    });
    
    if (!borrow) {
      return res.status(404).json({ 
        success: false, 
        message: 'Borrow record not found' 
      });
    }
    
    res.json({ success: true, borrow });
  } catch (error) {
    console.error('Get borrow error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPDATE borrow record (for corrections)
app.put('/api/borrows/:id', authenticate, async (req, res) => {
  try {
    const borrow = await Borrow.findOne({
      where: { id: req.params.id },
      include: [{ 
        model: Book,
        where: { schoolId: req.user.schoolId }
      }]
    });
    
    if (!borrow) {
      return res.status(404).json({ 
        success: false, 
        message: 'Borrow record not found' 
      });
    }

    const { dueDate, status, fine } = req.body;
    const oldBorrow = { ...borrow.toJSON() };
    
    await borrow.update({
      dueDate: dueDate || borrow.dueDate,
      status: status || borrow.status,
      fine: fine !== undefined ? fine : borrow.fine
    });

    await createAuditLog(req, 'UPDATE', 'BORROW', borrow.id, oldBorrow, borrow);

    res.json({ 
      success: true, 
      borrow,
      message: 'Borrow record updated successfully' 
    });
  } catch (error) {
    console.error('Update borrow error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE borrow record (rarely needed, mostly for corrections)
app.delete('/api/borrows/:id', authenticate, async (req, res) => {
  try {
    const borrow = await Borrow.findOne({
      where: { id: req.params.id },
      include: [{ 
        model: Book,
        where: { schoolId: req.user.schoolId }
      }]
    });
    
    if (!borrow) {
      return res.status(404).json({ 
        success: false, 
        message: 'Borrow record not found' 
      });
    }

    // If the book was borrowed, increase available count
    if (borrow.status === 'BORROWED') {
      await Book.update(
        { available: sequelize.literal('available + 1') },
        { where: { id: borrow.bookId } }
      );
    }

    await borrow.destroy();
    await createAuditLog(req, 'DELETE', 'BORROW', req.params.id);

    res.json({ 
      success: true, 
      message: 'Borrow record deleted successfully' 
    });
  } catch (error) {
    console.error('Delete borrow error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET library statistics
app.get('/api/library/stats', authenticate, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    const totalBooks = await Book.sum('quantity', { where: { schoolId } }) || 0;
    const availableBooks = await Book.sum('available', { where: { schoolId } }) || 0;
    
    const borrowedCount = await Borrow.count({
      where: { status: 'BORROWED' },
      include: [{
        model: Book,
        where: { schoolId },
        required: true
      }]
    });

    const overdueCount = await Borrow.count({
      where: { 
        status: 'BORROWED',
        dueDate: { [Op.lt]: new Date() }
      },
      include: [{
        model: Book,
        where: { schoolId },
        required: true
      }]
    });

    const uniqueStudents = await Borrow.findAll({
      where: { status: 'BORROWED' },
      include: [{
        model: Book,
        where: { schoolId },
        required: true
      }],
      attributes: [[sequelize.fn('DISTINCT', sequelize.col('studentId')), 'studentId']]
    });

    res.json({
      success: true,
      stats: {
        totalBooks,
        availableBooks,
        borrowedCount,
        overdueCount,
        activeBorrowers: uniqueStudents.length,
        collectionRate: totalBooks > 0 
          ? ((totalBooks - availableBooks) / totalBooks * 100).toFixed(2)
          : 0
      }
    });
  } catch (error) {
    console.error('Library stats error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET available books (for students)
app.get('/api/library/available', authenticate, async (req, res) => {
  try {
    const { search, category } = req.query;
    const where = { 
      schoolId: req.user.schoolId,
      available: { [Op.gt]: 0 }
    };

    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { author: { [Op.iLike]: `%${search}%` } }
      ];
    }

    if (category && category !== 'all') {
      where.category = category;
    }

    const books = await Book.findAll({
      where,
      order: [['title', 'ASC']]
    });

    res.json({ 
      success: true, 
      books,
      count: books.length
    });
  } catch (error) {
    console.error('Get available books error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET student's borrowed books by admission number
app.get('/api/library/by-admission/:admissionNumber/borrowed', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const borrows = await Borrow.findAll({
      where: { 
        studentId: student.id,
        status: 'BORROWED'
      },
      include: [
        { 
          model: Book,
          attributes: ['id', 'title', 'author', 'isbn', 'category'],
          required: false 
        }
      ],
      order: [['dueDate', 'ASC']]
    });

    res.json({ 
      success: true, 
      borrows,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get student borrowed books error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET student's borrow history by admission number
app.get('/api/library/by-admission/:admissionNumber/history', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    const { limit = 50 } = req.query;

    // Find student by admission number
    const student = await Student.findOne({
      where: { 
        schoolId: req.user.schoolId,
        admissionNumber 
      }
    });

    if (!student) {
      return res.status(404).json({ 
        success: false, 
        message: 'Student not found with this admission number' 
      });
    }

    const borrows = await Borrow.findAll({
      where: { studentId: student.id },
      include: [
        { 
          model: Book,
          attributes: ['id', 'title', 'author', 'isbn', 'category'],
          required: false 
        }
      ],
      order: [['borrowDate', 'DESC']],
      limit: parseInt(limit)
    });

    // Calculate statistics
    const stats = {
      totalBorrowed: borrows.length,
      currentlyBorrowed: borrows.filter(b => b.status === 'BORROWED').length,
      returned: borrows.filter(b => b.status === 'RETURNED').length,
      overdue: borrows.filter(b => b.status === 'BORROWED' && new Date(b.dueDate) < new Date()).length,
      totalFines: borrows.reduce((sum, b) => sum + (b.fine || 0), 0)
    };

    res.json({ 
      success: true, 
      borrows,
      stats,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get student borrow history error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== TIMETABLE ROUTES ====================
// ==================== FIXED GET TIMETABLE ====================
app.get('/api/timetable', authenticate, async (req, res) => {
  try {
    const { classId, courseId, programId, year, semester, module } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    const school = await School.findByPk(req.user.schoolId);
    
    if (!school) {
      return res.status(404).json({ message: 'School not found' });
    }
    
    // Build where clause based on school type
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
      if (year && !isNaN(parseInt(year))) where.year = parseInt(year);
      if (semester && !isNaN(parseInt(semester))) where.semester = parseInt(semester);
    } else if (school.category === 'COLLEGE_TVET') {
      if (programId) where.programId = programId;
      if (year && !isNaN(parseInt(year))) where.year = parseInt(year);
      if (module && !isNaN(parseInt(module))) where.module = parseInt(module);
    } else {
      if (classId) where.classId = classId;
    }

    let timetable = [];
    try {
      if (school.category === 'UNIVERSITY') {
        timetable = await Timetable.findAll({
          where,
          include: [
            { model: Course, required: false },
            { model: CourseUnit, as: 'unit', required: false },
            { 
              model: Staff, 
              as: 'teacher',
              include: [{ model: User, attributes: ['firstName', 'lastName'] }],
              required: false 
            }
          ],
          order: [['day', 'ASC'], ['period', 'ASC']]
        });
      } else if (school.category === 'COLLEGE_TVET') {
        timetable = await Timetable.findAll({
          where,
          include: [
            { model: Program, required: false },
            { model: CourseUnit, as: 'unit', required: false },
            { 
              model: Staff, 
              as: 'teacher',
              include: [{ model: User, attributes: ['firstName', 'lastName'] }],
              required: false 
            }
          ],
          order: [['day', 'ASC'], ['period', 'ASC']]
        });
      } else {
        timetable = await Timetable.findAll({
          where,
          include: [
            { model: Subject, required: false },
            { model: Class, required: false },
            { 
              model: Staff, 
              as: 'teacher',
              include: [{ model: User, attributes: ['firstName', 'lastName'] }],
              required: false 
            }
          ],
          order: [['day', 'ASC'], ['period', 'ASC']]
        });
      }
    } catch (includeError) {
      console.error('Error with includes, falling back to simple query:', includeError.message);
      timetable = await Timetable.findAll({ 
        where, 
        order: [['day', 'ASC'], ['period', 'ASC']] 
      });
    }
    
    res.json({ success: true, timetable });
  } catch (error) {
    console.error('Get timetable error:', error);
    res.status(500).json({ 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== FIXED POST TIMETABLE ====================
app.post('/api/timetable', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      classId, courseId, programId, year, semester, module, day, period, startTime, endTime,
      subjectId, unitId, teacherId, room
    } = req.body;

    if (!day) return res.status(400).json({ message: 'Day is required' });
    if (!period) return res.status(400).json({ message: 'Period is required' });
    if (!teacherId) return res.status(400).json({ message: 'Teacher is required' });
    if (!startTime) return res.status(400).json({ message: 'Start time is required' });
    if (!endTime) return res.status(400).json({ message: 'End time is required' });

    const school = await School.findByPk(req.user.schoolId);
    if (!school) return res.status(404).json({ message: 'School not found' });
    
    let timetableData = {
      day,
      period: parseInt(period),
      startTime,
      endTime,
      teacherId,
      room: room || null,
      schoolId: req.user.schoolId,
      classId: null,
      courseId: null,
      programId: null,
      unitId: null,
      subjectId: null,
      year: null,
      semester: null,
      module: null
    };

    if (school.category === 'UNIVERSITY') {
      if (!courseId) {
        return res.status(400).json({ 
          message: 'Course ID is required for university' 
        });
      }
      if (!unitId) {
        return res.status(400).json({ 
          message: 'Unit ID is required for university' 
        });
      }
      
      timetableData.courseId = courseId;
      timetableData.unitId = unitId;
      timetableData.year = year ? parseInt(year) : null;
      timetableData.semester = semester ? parseInt(semester) : null;
    } else if (school.category === 'COLLEGE_TVET') {
      if (!programId) {
        return res.status(400).json({ 
          message: 'Program ID is required for TVET' 
        });
      }
      if (!unitId) {
        return res.status(400).json({ 
          message: 'Unit/Module ID is required for TVET' 
        });
      }
      
      timetableData.programId = programId;
      timetableData.unitId = unitId;
      timetableData.year = year ? parseInt(year) : null;
      timetableData.module = module ? parseInt(module) : null;
    } else {
      if (!classId) {
        return res.status(400).json({ 
          message: 'Class ID is required for regular schools' 
        });
      }
      if (!subjectId) {
        return res.status(400).json({ 
          message: 'Subject ID is required for regular schools' 
        });
      }
      
      timetableData.classId = classId;
      timetableData.subjectId = subjectId;
    }

    // Check for scheduling conflicts
    const conflictWhere = {
      schoolId: req.user.schoolId,
      day,
      period: parseInt(period)
    };

    if (school.category === 'UNIVERSITY') {
      conflictWhere.courseId = courseId;
    } else if (school.category === 'COLLEGE_TVET') {
      conflictWhere.programId = programId;
    } else {
      conflictWhere.classId = classId;
    }

    const teacherConflict = await Timetable.findOne({
      where: {
        ...conflictWhere,
        teacherId: teacherId
      }
    });

    if (teacherConflict) {
      return res.status(400).json({ 
        message: 'Teacher is already assigned to another class at this time' 
      });
    }

    const timetable = await Timetable.create(timetableData);
    
    await createAuditLog(req, 'CREATE', 'TIMETABLE', timetable.id, null, timetable);

    let createdTimetable;
    if (school.category === 'UNIVERSITY') {
      createdTimetable = await Timetable.findByPk(timetable.id, {
        include: [
          { model: Course, attributes: ['id', 'name', 'code'] },
          { model: CourseUnit, as: 'unit', attributes: ['id', 'name', 'code'] },
          { 
            model: Staff, 
            as: 'teacher', 
            include: [{ model: User, attributes: ['id', 'firstName', 'lastName'] }]
          }
        ]
      });
    } else if (school.category === 'COLLEGE_TVET') {
      createdTimetable = await Timetable.findByPk(timetable.id, {
        include: [
          { model: Program, attributes: ['id', 'name', 'code'] },
          { model: CourseUnit, as: 'unit', attributes: ['id', 'name', 'code'] },
          { 
            model: Staff, 
            as: 'teacher', 
            include: [{ model: User, attributes: ['id', 'firstName', 'lastName'] }]
          }
        ]
      });
    } else {
      createdTimetable = await Timetable.findByPk(timetable.id, {
        include: [
          { model: Subject, attributes: ['id', 'name', 'code'] },
          { model: Class, attributes: ['id', 'name'] },
          { 
            model: Staff, 
            as: 'teacher', 
            include: [{ model: User, attributes: ['id', 'firstName', 'lastName'] }]
          }
        ]
      });
    }

    res.status(201).json({ success: true, timetable: createdTimetable });
  } catch (error) {
    console.error('Create timetable error:', error);
    
    if (error.name === 'SequelizeForeignKeyConstraintError') {
      return res.status(400).json({ 
        message: 'Invalid reference: The selected course, program, unit, or teacher does not exist',
        details: error.message 
      });
    }
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({ 
        message: 'Validation error',
        details: error.errors.map(e => e.message) 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error creating timetable',
      error: error.message
    });
  }
});

app.delete('/api/timetable/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const timetable = await Timetable.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!timetable) {
      return res.status(404).json({ message: 'Timetable entry not found' });
    }

    await timetable.destroy();
    await createAuditLog(req, 'DELETE', 'TIMETABLE', req.params.id);

    res.json({ success: true, message: 'Timetable entry deleted successfully' });
  } catch (error) {
    console.error('Delete timetable error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== VEHICLE ROUTES ====================

app.post('/api/vehicles', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      registration, type, capacity, driver, driverPhone,
      insuranceExpiry, serviceDue, fuelType
    } = req.body;

    if (!registration) {
      return res.status(400).json({ message: 'Registration number is required' });
    }

    const existingVehicle = await Vehicle.findOne({
      where: { 
        registration: registration.toUpperCase(),
        schoolId: req.user.schoolId 
      }
    });

    if (existingVehicle) {
      return res.status(400).json({ message: 'Vehicle with this registration already exists' });
    }

    const vehicle = await Vehicle.create({
      registration: registration.toUpperCase(),
      type: type || 'Unknown',
      capacity: capacity || 0,
      driver: driver || '',
      driverPhone: driverPhone || '',
      insuranceExpiry: insuranceExpiry || null,
      serviceDue: serviceDue || null,
      fuelType: fuelType || 'Diesel',
      status: 'ACTIVE',
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'VEHICLE', vehicle.id, null, vehicle);

    res.status(201).json({ success: true, vehicle });
  } catch (error) {
    console.error('Create vehicle error:', error);
    res.status(500).json({ 
      message: 'Server error', 
      error: error.message,
      details: error.errors?.map(e => e.message) 
    });
  }
});

app.get('/api/vehicles', authenticate, async (req, res) => {
  try {
    const vehicles = await Vehicle.findAll({
      where: { schoolId: req.user.schoolId }
    });
    
    res.json({ success: true, vehicles });
  } catch (error) {
    console.error('Get vehicles error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/vehicles/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });

    if (!vehicle) {
      return res.status(404).json({ message: 'Vehicle not found' });
    }

    const oldVehicle = { ...vehicle.toJSON() };
    await vehicle.update(req.body);
    await createAuditLog(req, 'UPDATE', 'VEHICLE', vehicle.id, oldVehicle, vehicle);

    res.json({ success: true, vehicle });
  } catch (error) {
    console.error('Update vehicle error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/vehicles/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });

    if (!vehicle) {
      return res.status(404).json({ message: 'Vehicle not found' });
    }

    const routes = await TransportRoute.findOne({ where: { vehicleId: vehicle.id } });
    if (routes) {
      return res.status(400).json({ 
        message: 'Cannot delete vehicle that is assigned to transport routes' 
      });
    }

    await vehicle.destroy();
    await createAuditLog(req, 'DELETE', 'VEHICLE', req.params.id);

    res.json({ success: true, message: 'Vehicle deleted successfully' });
  } catch (error) {
    console.error('Delete vehicle error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== TRANSPORT ROUTES ====================

app.post('/api/transport-routes', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      name, vehicleId, pickupPoints, pickupTimes,
      dropoffPoints, fee, students, autoAllocate
    } = req.body;

    const route = await TransportRoute.create({
      name,
      vehicleId,
      pickupPoints,
      pickupTimes,
      dropoffPoints,
      fee,
      students,
      autoAllocate,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'TRANSPORT_ROUTE', route.id, null, route);

    res.status(201).json({ success: true, route });
  } catch (error) {
    console.error('Create transport route error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/transport-routes', authenticate, async (req, res) => {
  try {
    const routes = await TransportRoute.findAll({
      where: { schoolId: req.user.schoolId },
      include: [{ model: Vehicle, required: false }]
    });
    
    res.json({ success: true, routes });
  } catch (error) {
    console.error('Get transport routes error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== HOSTEL ROUTES ====================

app.get('/api/hostels', authenticate, async (req, res) => {
  try {
    console.log('🏠 Fetching hostels for school:', req.user.schoolId);
    
    // Allow NURSE to view hostels
    const allowedRoles = ['SCHOOL_ADMIN', 'PRINCIPAL', 'MATRON', 'NURSE'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const result = await sequelize.query(
      `SELECT * FROM "Hostels" 
       WHERE "schoolId" = $1 
       ORDER BY name ASC`,
      {
        bind: [req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    const hostels = result.map(hostel => ({
      ...hostel,
      rooms: typeof hostel.rooms === 'string' ? JSON.parse(hostel.rooms) : (hostel.rooms || [])
    }));
    
    console.log('🏠 Found hostels:', hostels.length);
    res.json({ success: true, hostels });
  } catch (error) {
    console.error('❌ Get hostels error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
app.get('/api/hostels/:id', authenticate, async (req, res) => {
  try {
    // Allow NURSE to view hostels
    const allowedRoles = ['SCHOOL_ADMIN', 'PRINCIPAL', 'MATRON', 'NURSE'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const result = await sequelize.query(
      `SELECT * FROM "Hostels" 
       WHERE id = $1 AND "schoolId" = $2`,
      {
        bind: [req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    if (!result || result.length === 0) {
      return res.status(404).json({ message: 'Hostel not found' });
    }
    
    const hostel = {
      ...result[0],
      rooms: typeof result[0].rooms === 'string' ? JSON.parse(result[0].rooms) : (result[0].rooms || [])
    };
    
    res.json({ success: true, hostel });
  } catch (error) {
    console.error('❌ Get hostel error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
app.post('/api/hostels', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, gender, capacity, warden, wardenPhone, rooms } = req.body;
    
    // Ensure rooms is an array and stringify properly
    const roomsArray = rooms || [];
    const roomsJson = JSON.stringify(roomsArray);
    
    console.log('📝 Creating hostel with rooms:', roomsJson);
    
    const result = await sequelize.query(
      `INSERT INTO "Hostels" 
       (id, name, gender, capacity, warden, "wardenPhone", rooms, "schoolId", "createdAt", "updatedAt") 
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW()) 
       RETURNING *`,
      {
        bind: [name, gender, capacity, warden || '', wardenPhone || '', roomsJson, req.user.schoolId],
        type: sequelize.QueryTypes.INSERT
      }
    );
    
    console.log('📥 Database result:', result);
    
    // Check if result has the expected structure
    if (!result || !result[0] || !result[0][0]) {
      throw new Error('Invalid database response');
    }
    
    const dbRow = result[0][0];
    console.log('📊 Database row:', dbRow);
    
    // Safely parse rooms
    let parsedRooms = [];
    if (dbRow.rooms) {
      try {
        parsedRooms = typeof dbRow.rooms === 'string' 
          ? JSON.parse(dbRow.rooms) 
          : dbRow.rooms;
      } catch (parseError) {
        console.error('❌ Error parsing rooms:', parseError);
        parsedRooms = [];
      }
    }
    
    const hostel = {
      id: dbRow.id,
      name: dbRow.name,
      gender: dbRow.gender,
      capacity: dbRow.capacity,
      warden: dbRow.warden,
      wardenPhone: dbRow.wardenPhone,
      schoolId: dbRow.schoolId,
      createdAt: dbRow.createdAt,
      updatedAt: dbRow.updatedAt,
      rooms: parsedRooms
    };
    
    console.log('✅ Hostel created successfully:', hostel.id);
    console.log('✅ Hostel rooms:', parsedRooms);
    
    res.status(201).json({ success: true, hostel });
  } catch (error) {
    console.error('❌ Create hostel error:', error);
    console.error('❌ Error stack:', error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.put('/api/hostels/:id', authenticate, async (req, res) => {
  try {
    const { name, gender, capacity, warden, wardenPhone, rooms } = req.body;
    
    // Check permissions - allow NURSE for sick bay updates
    const allowedRoles = ['SCHOOL_ADMIN', 'PRINCIPAL', 'MATRON', 'NURSE'];
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. You do not have permission to update hostels.' 
      });
    }
    
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (name !== undefined) {
      updates.push(`name = $${paramIndex++}`);
      values.push(name);
    }
    if (gender !== undefined) {
      updates.push(`gender = $${paramIndex++}`);
      values.push(gender);
    }
    if (capacity !== undefined) {
      updates.push(`capacity = $${paramIndex++}`);
      values.push(capacity);
    }
    if (warden !== undefined) {
      updates.push(`warden = $${paramIndex++}`);
      values.push(warden);
    }
    if (wardenPhone !== undefined) {
      updates.push(`"wardenPhone" = $${paramIndex++}`);
      values.push(wardenPhone);
    }
    if (rooms !== undefined) {
      updates.push(`rooms = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(rooms));
    }
    
    updates.push(`"updatedAt" = NOW()`);
    values.push(req.params.id, req.user.schoolId);
    
    const query = `
      UPDATE "Hostels" 
      SET ${updates.join(', ')} 
      WHERE id = $${paramIndex++} AND "schoolId" = $${paramIndex++}
      RETURNING *
    `;
    
    const result = await sequelize.query(query, {
      bind: values,
      type: sequelize.QueryTypes.UPDATE
    });
    
    if (!result || result.length === 0 || result[0].length === 0) {
      return res.status(404).json({ message: 'Hostel not found' });
    }
    
    const hostel = {
      ...result[0][0],
      rooms: typeof result[0][0].rooms === 'string' ? JSON.parse(result[0][0].rooms) : (result[0][0].rooms || [])
    };
    
    console.log('✅ Hostel updated:', hostel.id);
    res.json({ success: true, hostel });
  } catch (error) {
    console.error('❌ Update hostel error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/hostels/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const result = await sequelize.query(
      `DELETE FROM "Hostels" 
       WHERE id = $1 AND "schoolId" = $2 
       RETURNING id`,
      {
        bind: [req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.DELETE
      }
    );
    
    if (!result || result.length === 0 || result[0].length === 0) {
      return res.status(404).json({ message: 'Hostel not found' });
    }
    
    console.log('✅ Hostel deleted:', req.params.id);
    res.json({ success: true, message: 'Hostel deleted successfully' });
  } catch (error) {
    console.error('❌ Delete hostel error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/hostels/:hostelId/rooms/:roomNumber/assign', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { hostelId, roomNumber } = req.params;
    const { studentId } = req.body;

    console.log('📝 BACKEND: Assigning room by user:', req.user.email);

    const transaction = await sequelize.transaction();

    try {
      const [hostelResult] = await sequelize.query(
        `SELECT * FROM "Hostels" 
         WHERE id = $1 AND "schoolId" = $2 
         FOR UPDATE`,
        {
          bind: [hostelId, req.user.schoolId],
          type: sequelize.QueryTypes.SELECT,
          transaction
        }
      );
      
      if (!hostelResult) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Hostel not found' });
      }

      let rooms = hostelResult.rooms;
      if (typeof rooms === 'string') {
        rooms = JSON.parse(rooms);
      }
      rooms = rooms || [];
      
      const roomIndex = rooms.findIndex(r => r.roomNumber === roomNumber);
      if (roomIndex === -1) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Room not found' });
      }

      if (!rooms[roomIndex].students) {
        rooms[roomIndex].students = [];
      }

      if (rooms[roomIndex].students.includes(studentId)) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Student already assigned to this room' });
      }

      const currentOccupied = rooms[roomIndex].occupied || rooms[roomIndex].students.length || 0;
      if (currentOccupied >= rooms[roomIndex].beds) {
        await transaction.rollback();
        return res.status(400).json({ message: 'Room is full' });
      }

      rooms[roomIndex].students.push(studentId);
      rooms[roomIndex].occupied = rooms[roomIndex].students.length;

      const roomsJson = JSON.stringify(rooms);
      await sequelize.query(
        `UPDATE "Hostels" 
         SET rooms = $1::jsonb, "updatedAt" = NOW() 
         WHERE id = $2`,
        {
          bind: [roomsJson, hostelId],
          type: sequelize.QueryTypes.UPDATE,
          transaction
        }
      );

      await transaction.commit();

      const [updatedResult] = await sequelize.query(
        `SELECT * FROM "Hostels" WHERE id = $1`,
        {
          bind: [hostelId],
          type: sequelize.QueryTypes.SELECT
        }
      );

      const updatedHostel = {
        ...updatedResult,
        rooms: typeof updatedResult.rooms === 'string' ? JSON.parse(updatedResult.rooms) : (updatedResult.rooms || [])
      };

      await createAuditLog(req, 'ASSIGN', 'HOSTEL_ROOM', hostelId, null, { 
        roomNumber, 
        studentId,
        occupied: rooms[roomIndex].occupied,
        beds: rooms[roomIndex].beds
      });

      console.log('✅ Room assigned successfully');
      res.json({ success: true, hostel: updatedHostel });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('❌ BACKEND: Assign room error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/hostels/:hostelId/rooms/:roomNumber/students/:studentId', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { hostelId, roomNumber, studentId } = req.params;

    console.log('📝 BACKEND: Removing student:', { hostelId, roomNumber, studentId });

    const transaction = await sequelize.transaction();

    try {
      const [hostelResult] = await sequelize.query(
        `SELECT * FROM "Hostels" 
         WHERE id = $1 AND "schoolId" = $2 
         FOR UPDATE`,
        {
          bind: [hostelId, req.user.schoolId],
          type: sequelize.QueryTypes.SELECT,
          transaction
        }
      );
      
      if (!hostelResult) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Hostel not found' });
      }

      let rooms = hostelResult.rooms;
      if (typeof rooms === 'string') {
        rooms = JSON.parse(rooms);
      }
      rooms = rooms || [];
      
      const roomIndex = rooms.findIndex(r => r.roomNumber === roomNumber);
      if (roomIndex === -1) {
        await transaction.rollback();
        return res.status(404).json({ message: 'Room not found' });
      }

      rooms[roomIndex].students = (rooms[roomIndex].students || []).filter(id => id !== studentId);
      rooms[roomIndex].occupied = rooms[roomIndex].students.length;

      const roomsJson = JSON.stringify(rooms);
      await sequelize.query(
        `UPDATE "Hostels" 
         SET rooms = $1::jsonb, "updatedAt" = NOW() 
         WHERE id = $2`,
        {
          bind: [roomsJson, hostelId],
          type: sequelize.QueryTypes.UPDATE,
          transaction
        }
      );

      await transaction.commit();

      const [updatedResult] = await sequelize.query(
        `SELECT * FROM "Hostels" WHERE id = $1`,
        {
          bind: [hostelId],
          type: sequelize.QueryTypes.SELECT
        }
      );

      const updatedHostel = {
        ...updatedResult,
        rooms: typeof updatedResult.rooms === 'string' ? JSON.parse(updatedResult.rooms) : (updatedResult.rooms || [])
      };

      console.log('✅ Student removed successfully');
      res.json({ success: true, hostel: updatedHostel });
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } catch (error) {
    console.error('❌ BACKEND: Remove student error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== INVENTORY ROUTES ====================

app.get('/api/inventory', authenticate, async (req, res) => {
  try {
    console.log('📦 Fetching inventory for school:', req.user.schoolId);
    
    const items = await sequelize.query(
      `SELECT * FROM "Inventories" 
       WHERE "schoolId" = $1 
       ORDER BY name ASC`,
      {
        bind: [req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    res.json({ success: true, items });
  } catch (error) {
    console.error('❌ Get inventory error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory/:id', authenticate, async (req, res) => {
  try {
    const item = await sequelize.query(
      `SELECT * FROM "Inventories" 
       WHERE id = $1 AND "schoolId" = $2`,
      {
        bind: [req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    if (!item || item.length === 0) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }
    
    res.json({ success: true, item: item[0] });
  } catch (error) {
    console.error('❌ Get inventory item error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.post('/api/inventory', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const {
      name, category, quantity, unit, unitPrice,
      reorderLevel, supplier, location, notes
    } = req.body;

    console.log('📦 Creating inventory item:', { name, category, quantity, unit, unitPrice });

    const totalValue = quantity * unitPrice;

    const result = await sequelize.query(
      `INSERT INTO "Inventories" 
       (id, name, category, quantity, unit, "unitPrice", "totalValue", 
        "reorderLevel", supplier, location, notes, "schoolId", "createdAt", "updatedAt") 
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW()) 
       RETURNING *`,
      {
        bind: [
          name,                // $1
          category,            // $2
          quantity,            // $3
          unit,                // $4
          unitPrice,           // $5
          totalValue,          // $6
          reorderLevel || 0,   // $7
          supplier || null,    // $8
          location || null,    // $9
          notes || null,       // $10
          req.user.schoolId    // $11
        ],
        type: sequelize.QueryTypes.INSERT
      }
    );

    console.log('✅ Inventory item created successfully');
    res.status(201).json({ success: true, item: result[0][0] });
  } catch (error) {
    console.error('❌ Create inventory error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.put('/api/inventory/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, category, quantity, unit, unitPrice, reorderLevel, supplier, location, notes } = req.body;
    
    const totalValue = quantity * unitPrice;
    
    const result = await sequelize.query(
      `UPDATE "Inventories" 
       SET name = $1, category = $2, quantity = $3, unit = $4, 
           "unitPrice" = $5, "totalValue" = $6, "reorderLevel" = $7,
           supplier = $8, location = $9, notes = $10, "updatedAt" = NOW()
       WHERE id = $11 AND "schoolId" = $12
       RETURNING *`,
      {
        bind: [name, category, quantity, unit, unitPrice, totalValue, 
               reorderLevel, supplier, location, notes, req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.UPDATE
      }
    );
    
    if (!result || result.length === 0 || result[0].length === 0) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }
    
    res.json({ success: true, item: result[0][0] });
  } catch (error) {
    console.error('❌ Update inventory error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.delete('/api/inventory/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const result = await sequelize.query(
      `DELETE FROM "Inventories" 
       WHERE id = $1 AND "schoolId" = $2 
       RETURNING id`,
      {
        bind: [req.params.id, req.user.schoolId],
        type: sequelize.QueryTypes.DELETE
      }
    );
    
    if (!result || result.length === 0 || result[0].length === 0) {
      return res.status(404).json({ message: 'Inventory item not found' });
    }
    
    res.json({ success: true, message: 'Inventory item deleted successfully' });
  } catch (error) {
    console.error('❌ Delete inventory error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.patch('/api/inventory/:id/use', authenticate, async (req, res) => {
  const transaction = await sequelize.transaction();
  
  try {
    const { quantity, reason, department } = req.body;
    const { id } = req.params;

    console.log('📝 Using inventory item:', { id, quantity, reason, department });

    const [item] = await sequelize.query(
      `SELECT * FROM "Inventories" 
       WHERE id = $1 AND "schoolId" = $2 
       FOR UPDATE`,
      {
        bind: [id, req.user.schoolId],
        type: sequelize.QueryTypes.SELECT,
        transaction
      }
    );

    if (!item) {
      await transaction.rollback();
      return res.status(404).json({ message: 'Item not found' });
    }

    if (quantity > item.quantity) {
      await transaction.rollback();
      return res.status(400).json({ message: `Only ${item.quantity} items available` });
    }

    const newQuantity = item.quantity - quantity;
    const newTotalValue = newQuantity * item.unitPrice;

    await sequelize.query(
      `UPDATE "Inventories" 
       SET quantity = $1, "totalValue" = $2, "updatedAt" = NOW()
       WHERE id = $3`,
      {
        bind: [newQuantity, newTotalValue, id],
        type: sequelize.QueryTypes.UPDATE,
        transaction
      }
    );

    await sequelize.query(
      `INSERT INTO "InventoryUsages" 
       (id, "inventoryId", quantity, reason, department, "usedBy", date, "createdAt", "updatedAt") 
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW(), NOW())`,
      {
        bind: [id, quantity, reason, department, req.user.id],
        type: sequelize.QueryTypes.INSERT,
        transaction
      }
    );

    await transaction.commit();

    const [updatedItem] = await sequelize.query(
      `SELECT * FROM "Inventories" WHERE id = $1`,
      {
        bind: [id],
        type: sequelize.QueryTypes.SELECT
      }
    );

    console.log('✅ Item used successfully');
    res.json({ 
      success: true, 
      item: updatedItem,
      message: `Used ${quantity} ${item.unit}(s) of ${item.name}`
    });
  } catch (error) {
    await transaction.rollback();
    console.error('❌ Use inventory item error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory-usage', authenticate, async (req, res) => {
  try {
    const { inventoryId, startDate, endDate, department, limit = 100 } = req.query;
    
    let query = `
      SELECT 
        u.id,
        u.quantity,
        u.reason,
        u.department,
        u.date,
        u."usedBy",
        u."createdAt",
        u."updatedAt",
        i.id as "inventoryId",
        i.name as "itemName",
        i.category,
        i.unit,
        i."unitPrice",
        CONCAT(us."firstName", ' ', us."lastName") as "usedByName",
        us.id as "userId",
        us.email as "userEmail"
      FROM "InventoryUsages" u
      INNER JOIN "Inventories" i ON u."inventoryId" = i.id
      LEFT JOIN "Users" us ON u."usedBy" = us.id
      WHERE i."schoolId" = $1
    `;
    
    const params = [req.user.schoolId];
    let paramIndex = 2;
    
    if (inventoryId) {
      query += ` AND u."inventoryId" = $${paramIndex}`;
      params.push(inventoryId);
      paramIndex++;
    }
    
    if (department) {
      query += ` AND u.department ILIKE $${paramIndex}`;
      params.push(`%${department}%`);
      paramIndex++;
    }
    
    if (startDate && endDate) {
      query += ` AND u.date BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }
    
    query += ` ORDER BY u.date DESC, u."createdAt" DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit) || 100);

    console.log('📊 Executing usage query with params:', params);
    
    const usage = await sequelize.query(query, {
      bind: params,
      type: sequelize.QueryTypes.SELECT
    });

    console.log(`✅ Found ${usage.length} usage records`);
    
    if (usage.length === 0) {
      const simpleQuery = await sequelize.query(
        `SELECT * FROM "InventoryUsages" LIMIT 5`,
        { type: sequelize.QueryTypes.SELECT }
      );
      console.log('📊 Sample raw usage:', simpleQuery);
    }

    res.json({ success: true, usage });
  } catch (error) {
    console.error('❌ Get inventory usage error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

app.get('/api/inventory/low-stock', authenticate, async (req, res) => {
  try {
    const items = await sequelize.query(
      `SELECT * FROM "Inventories" 
       WHERE "schoolId" = $1 
       AND quantity <= "reorderLevel"
       ORDER BY (quantity::float / NULLIF("reorderLevel", 0)) ASC`,
      {
        bind: [req.user.schoolId],
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    res.json({ success: true, items });
  } catch (error) {
    console.error('❌ Get low stock error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory/reports/usage', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, department } = req.query;

    let whereClause = `WHERE i."schoolId" = $1`;
    const params = [req.user.schoolId];
    let paramIndex = 2;

    if (startDate && endDate) {
      whereClause += ` AND u.date BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(startDate, endDate);
      paramIndex += 2;
    }

    if (department) {
      whereClause += ` AND u.department = $${paramIndex}`;
      params.push(department);
    }

    const byDepartment = await sequelize.query(`
      SELECT 
        u.department,
        COUNT(*) as "transactionCount",
        SUM(u.quantity) as "totalQuantity",
        SUM(u.quantity * i."unitPrice") as "totalValue"
      FROM "InventoryUsages" u
      INNER JOIN "Inventories" i ON u."inventoryId" = i.id
      ${whereClause}
      GROUP BY u.department
      ORDER BY "totalValue" DESC
    `, {
      bind: params,
      type: sequelize.QueryTypes.SELECT
    });

    const byCategory = await sequelize.query(`
      SELECT 
        i.category,
        COUNT(*) as "transactionCount",
        SUM(u.quantity) as "totalQuantity",
        SUM(u.quantity * i."unitPrice") as "totalValue"
      FROM "InventoryUsages" u
      INNER JOIN "Inventories" i ON u."inventoryId" = i.id
      ${whereClause}
      GROUP BY i.category
      ORDER BY "totalValue" DESC
    `, {
      bind: params,
      type: sequelize.QueryTypes.SELECT
    });

    const recent = await sequelize.query(`
      SELECT 
        u.*,
        i.name as "itemName",
        i.category,
        i.unit,
        CONCAT(us."firstName", ' ', us."lastName") as "usedByName"
      FROM "InventoryUsages" u
      INNER JOIN "Inventories" i ON u."inventoryId" = i.id
      LEFT JOIN "Users" us ON u."usedBy" = us.id
      ${whereClause}
      ORDER BY u.date DESC
      LIMIT 50
    `, {
      bind: params,
      type: sequelize.QueryTypes.SELECT
    });

    res.json({
      success: true,
      report: {
        byDepartment,
        byCategory,
        recent,
        summary: {
          totalTransactions: recent.length,
          totalValue: byDepartment.reduce((sum, d) => sum + parseFloat(d.totalValue || 0), 0)
        }
      }
    });

  } catch (error) {
    console.error('❌ Inventory usage report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory/reports/stock', authenticate, async (req, res) => {
  try {
    const stock = await sequelize.query(`
      SELECT 
        category,
        COUNT(*) as "itemCount",
        SUM(quantity) as "totalQuantity",
        SUM(quantity * "unitPrice") as "totalValue",
        COUNT(CASE WHEN quantity <= "reorderLevel" THEN 1 END) as "lowStockCount",
        COUNT(CASE WHEN quantity = 0 THEN 1 END) as "outOfStockCount"
      FROM "Inventories"
      WHERE "schoolId" = $1
      GROUP BY category
      ORDER BY "totalValue" DESC
    `, {
      bind: [req.user.schoolId],
      type: sequelize.QueryTypes.SELECT
    });

    const lowStock = await sequelize.query(`
      SELECT *
      FROM "Inventories"
      WHERE "schoolId" = $1 AND quantity <= "reorderLevel"
      ORDER BY (quantity::float / NULLIF("reorderLevel", 0)) ASC
    `, {
      bind: [req.user.schoolId],
      type: sequelize.QueryTypes.SELECT
    });

    res.json({
      success: true,
      report: {
        byCategory: stock,
        lowStock,
        summary: {
          totalCategories: stock.length,
          totalItems: stock.reduce((sum, c) => sum + parseInt(c.itemCount), 0),
          totalValue: stock.reduce((sum, c) => sum + parseFloat(c.totalValue || 0), 0)
        }
      }
    });

  } catch (error) {
    console.error('❌ Inventory stock report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/inventory/dashboard', authenticate, async (req, res) => {
  try {
    const summary = await sequelize.query(`
      WITH stats AS (
        SELECT 
          COUNT(*) as "totalItems",
          SUM(quantity) as "totalQuantity",
          SUM(quantity * "unitPrice") as "totalValue",
          COUNT(CASE WHEN quantity <= "reorderLevel" THEN 1 END) as "lowStockItems",
          COUNT(CASE WHEN quantity = 0 THEN 1 END) as "outOfStockItems"
        FROM "Inventories"
        WHERE "schoolId" = $1
      ),
      recent_usage AS (
        SELECT 
          COALESCE(SUM(u.quantity), 0) as "usedLast30Days",
          COALESCE(COUNT(DISTINCT u.id), 0) as "usageTransactions"
        FROM "InventoryUsages" u
        INNER JOIN "Inventories" i ON u."inventoryId" = i.id
        WHERE i."schoolId" = $1
        AND u.date >= NOW() - INTERVAL '30 days'
      )
      SELECT 
        json_build_object(
          'inventory', (SELECT row_to_json(stats) FROM stats),
          'usage', (SELECT row_to_json(recent_usage) FROM recent_usage)
        ) as dashboard
    `, {
      bind: [req.user.schoolId],
      type: sequelize.QueryTypes.SELECT
    });

    res.json({
      success: true,
      dashboard: summary[0]?.dashboard || {
        inventory: { totalItems: 0, totalValue: 0, lowStockItems: 0 },
        usage: { usedLast30Days: 0, usageTransactions: 0 }
      }
    });

  } catch (error) {
    console.error('❌ Inventory dashboard error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== ANNOUNCEMENT ROUTES ====================

app.post('/api/announcements', authenticate, async (req, res) => {
  try {
    const { title, content, audience, expiresAt } = req.body;

    const announcement = await Announcement.create({
      title,
      content,
      audience,
      expiresAt,
      createdBy: req.user.id,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'ANNOUNCEMENT', announcement.id, null, announcement);

    res.status(201).json({ success: true, announcement });
  } catch (error) {
    console.error('Create announcement error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
app.get('/api/announcements/:id', authenticate, async (req, res) => {
  try {
    const announcement = await Announcement.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    res.json({ success: true, announcement });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/announcements', authenticate, async (req, res) => {
  try {
    const announcements = await Announcement.findAll({
      where: {
        schoolId: req.user.schoolId,
        isActive: true,
        [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gte]: new Date() } }]
      },
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, announcements });
  } catch (error) {
    console.error('Get announcements error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});
app.put('/api/announcements/:id', authenticate, async (req, res) => {
  try {
    const announcement = await Announcement.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    
    await announcement.update(req.body);
    res.json({ success: true, announcement });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
app.delete('/api/announcements/:id', authenticate, async (req, res) => {
  try {
    const announcement = await Announcement.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    
    await announcement.destroy();
    res.json({ success: true, message: 'Announcement deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});
// ==================== EVENT ROUTES ====================

app.post('/api/events', authenticate, async (req, res) => {
  try {
    const { title, description, startDate, endDate, location, type, audience } = req.body;

    const event = await Event.create({
      title,
      description,
      startDate,
      endDate,
      location,
      type,
      audience,
      createdBy: req.user.id,
      schoolId: req.user.schoolId
    });

    await createAuditLog(req, 'CREATE', 'EVENT', event.id, null, event);

    res.status(201).json({ success: true, event });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/events', authenticate, async (req, res) => {
  try {
    const events = await Event.findAll({
      where: { schoolId: req.user.schoolId },
      order: [['startDate', 'DESC']]
    });
    res.json({ success: true, events });
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/events/upcoming', authenticate, async (req, res) => {
  try {
    const events = await Event.findAll({
      where: {
        schoolId: req.user.schoolId,
        startDate: { [Op.gte]: new Date() }
      },
      order: [['startDate', 'ASC']],
      limit: 10
    });
    
    res.json({ success: true, events });
  } catch (error) {
    console.error('Get upcoming events error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== FEATURE ROUTES ====================

app.get('/api/features', authenticate, async (req, res) => {
  try {
    const features = await Feature.findAll({
      where: { schoolId: req.user.schoolId }
    });
    
    res.json({ success: true, features });
  } catch (error) {
    console.error('Get features error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.patch('/api/features/:code/toggle', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const [feature, created] = await Feature.findOrCreate({
      where: { code: req.params.code, schoolId: req.user.schoolId },
      defaults: {
        name: req.params.code,
        code: req.params.code,
        category: 'GENERAL',
        isEnabled: true,
        schoolId: req.user.schoolId
      }
    });

    if (!created) {
      await feature.update({ isEnabled: !feature.isEnabled });
    }

    await createAuditLog(req, 'TOGGLE_FEATURE', 'FEATURE', feature.id, { isEnabled: !feature.isEnabled }, { isEnabled: feature.isEnabled });

    res.json({ success: true, feature });
  } catch (error) {
    console.error('Toggle feature error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== AUDIT LOGS ROUTE ====================

app.get('/api/audit-logs', authenticate, async (req, res) => {
  try {
    const { entity, action, startDate, endDate, limit = 100 } = req.query;
    const where = {};
    
    if (req.user.role !== 'SUPER_ADMIN') {
      where.schoolId = req.user.schoolId;
    }

    if (entity) where.entity = entity;
    if (action) where.action = action;
    if (startDate && endDate) {
      where.timestamp = { 
        [Op.between]: [new Date(startDate), new Date(endDate)] 
      };
    }

    const logs = await AuditLog.findAll({
      where,
      include: [
        { 
          model: User, 
          attributes: ['id', 'firstName', 'lastName', 'email', 'role'],
          required: false
        }
      ],
      order: [['timestamp', 'DESC']],
      limit: parseInt(limit)
    });
    
    const formattedLogs = logs.map(log => {
      const logJson = log.toJSON();
      
      if (logJson.User) {
        logJson.userName = `${logJson.User.firstName || ''} ${logJson.User.lastName || ''}`.trim() || logJson.User.email || 'Unknown';
      } 
      else if (logJson.userId) {
        logJson.userName = `User ${logJson.userId.substring(0, 8)}...`;
      }
      else {
        logJson.userName = 'System';
      }
      
      return logJson;
    });
    
    res.json({ 
      success: true, 
      logs: formattedLogs,
      count: formattedLogs.length
    });
  } catch (error) {
    console.error('❌ Get audit logs error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// ==================== REPORT ROUTES ====================

app.get('/api/reports/student-performance/:studentId', authenticate, async (req, res) => {
  try {
    const studentId = req.params.studentId;

    if (!await checkStudentAccess(studentId, req.user)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const student = await Student.findByPk(studentId, {
      include: [{ model: Class }]
    });

    const school = await School.findByPk(req.user.schoolId);
    const gradingSystem = getGradingSystem(school.category);

    const results = await Result.findAll({
      where: { studentId },
      include: [
        { model: Exam, required: false },
        { model: Subject, required: false }
      ],
      order: [['createdAt', 'DESC']]
    });

    const subjectAverages = {};
    results.forEach(result => {
      const subjectName = result.Subject?.name || 'Unknown';
      if (!subjectAverages[subjectName]) {
        subjectAverages[subjectName] = {
          total: 0,
          count: 0,
          subject: result.Subject
        };
      }
      subjectAverages[subjectName].total += result.marks;
      subjectAverages[subjectName].count += 1;
    });

    Object.keys(subjectAverages).forEach(key => {
      subjectAverages[key].average = subjectAverages[key].total / subjectAverages[key].count;
    });

    const examPerformance = {};
    results.forEach(result => {
      if (!examPerformance[result.Exam?.name]) {
        examPerformance[result.Exam?.name] = {
          exam: result.Exam,
          subjects: []
        };
      }
      examPerformance[result.Exam?.name].subjects.push({
        subject: result.Subject?.name,
        marks: result.marks,
        grade: result.grade,
        gradeCode: result.gradeCode,
        points: result.points
      });
    });

    const totalPoints = results.reduce((sum, r) => sum + (r.points || 0), 0);
    const meanGrade = gradingSystem.calculateMeanGrade ? 
      gradingSystem.calculateMeanGrade(totalPoints) : 
      (results.length > 0 ? results[0].grade : 'N/A');

    res.json({
      success: true,
      report: {
        student,
        class: student.Class,
        gradingSystem: gradingSystem.name,
        summary: {
          totalExams: results.length,
          subjectAverages,
          overallAverage: results.length ? (results.reduce((sum, r) => sum + r.marks, 0) / results.length).toFixed(2) : 0,
          totalPoints,
          meanGrade
        },
        examPerformance,
        detailedResults: results
      }
    });
  } catch (error) {
    console.error('Generate student report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/reports/class-performance/:classId', authenticate, async (req, res) => {
  try {
    const classId = req.params.classId;
    const { examId, courseId, year } = req.query;
    
    const school = await School.findByPk(req.user.schoolId);
    const gradingSystem = getGradingSystem(school.category);
    
    if (school.category === 'UNIVERSITY' || school.category === 'COLLEGE_TVET') {
      const where = { schoolId: req.user.schoolId };
      if (courseId) where.courseId = courseId;
      if (year) where.currentYear = year;
      
      const students = await Student.findAll({ where });
      
      const examWhere = { schoolId: req.user.schoolId };
      if (courseId) examWhere.courseId = courseId;
      
      const exams = await Exam.findAll({ where: examWhere });
      
      const results = await Result.findAll({
        where: { examId: { [Op.in]: exams.map(e => e.id) } },
        include: [
          { model: Student },
          { model: Exam, include: [{ model: Course }] }
        ]
      });
      
      const studentPerformance = {};
      results.forEach(result => {
        if (!studentPerformance[result.studentId]) {
          studentPerformance[result.studentId] = {
            student: result.Student,
            courses: {},
            totalMarks: 0,
            examCount: 0,
            totalPoints: 0
          };
        }
        
        const courseName = result.Exam.Course?.name || 'Unknown';
        if (!studentPerformance[result.studentId].courses[courseName]) {
          studentPerformance[result.studentId].courses[courseName] = [];
        }
        
        studentPerformance[result.studentId].courses[courseName].push({
          exam: result.Exam.name,
          marks: result.marks,
          grade: result.grade,
          points: result.points
        });
        
        studentPerformance[result.studentId].totalMarks += result.marks;
        studentPerformance[result.studentId].totalPoints += result.points || 0;
        studentPerformance[result.studentId].examCount += 1;
      });
      
      Object.values(studentPerformance).forEach(s => {
        s.average = s.totalMarks / s.examCount;
        s.gpa = s.totalPoints / s.examCount;
      });
      
      return res.json({
        success: true,
        report: {
          type: school.category,
          gradingSystem: gradingSystem.name,
          course: courseId ? await Course.findByPk(courseId) : null,
          year,
          studentPerformance: Object.values(studentPerformance),
          summary: {
            totalStudents: students.length,
            totalExams: exams.length,
            classAverage: Object.values(studentPerformance).reduce((sum, s) => sum + s.average, 0) / (Object.values(studentPerformance).length || 1)
          }
        }
      });
    } else {
      const classObj = await Class.findByPk(classId, {
        include: [{ model: Student }]
      });

      const where = { classId };
      if (examId) {
        where['$Exam.id$'] = examId;
      }

      const results = await Result.findAll({
        where,
        include: [
          { model: Student, required: false },
          { model: Exam, required: false },
          { model: Subject, required: false }
        ]
      });

      const studentPerformance = {};
      results.forEach(result => {
        if (!studentPerformance[result.studentId]) {
          studentPerformance[result.studentId] = {
            student: result.Student,
            subjects: [],
            totalMarks: 0,
            examCount: 0,
            totalPoints: 0
          };
        }
        studentPerformance[result.studentId].subjects.push({
          subject: result.Subject?.name,
          exam: result.Exam?.name,
          marks: result.marks,
          grade: result.grade,
          points: result.points
        });
        studentPerformance[result.studentId].totalMarks += result.marks;
        studentPerformance[result.studentId].totalPoints += result.points || 0;
        studentPerformance[result.studentId].examCount += 1;
      });

      Object.values(studentPerformance).forEach(s => {
        s.average = s.totalMarks / s.examCount;
        s.meanGrade = calculateMeanGrade(results.filter(r => r.studentId === s.student.id), school.category);
      });

      const subjectAverages = {};
      results.forEach(result => {
        const subjectName = result.Subject?.name;
        if (subjectName) {
          if (!subjectAverages[subjectName]) {
            subjectAverages[subjectName] = {
              total: 0,
              count: 0,
              marks: []
            };
          }
          subjectAverages[subjectName].total += result.marks;
          subjectAverages[subjectName].count += 1;
          subjectAverages[subjectName].marks.push(result.marks);
        }
      });

      Object.keys(subjectAverages).forEach(key => {
        subjectAverages[key].average = subjectAverages[key].total / subjectAverages[key].count;
      });

      res.json({
        success: true,
        report: {
          class: classObj,
          gradingSystem: gradingSystem.name,
          summary: {
            totalStudents: classObj?.Students?.length || 0,
            totalExams: results.length,
            classAverage: Object.values(studentPerformance).reduce((sum, s) => sum + s.average, 0) / (Object.values(studentPerformance).length || 1)
          },
          studentPerformance: Object.values(studentPerformance),
          subjectAverages
        }
      });
    }
  } catch (error) {
    console.error('Generate report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/reports/financial', authenticate, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const where = { schoolId: req.user.schoolId };

    if (startDate && endDate) {
      where.date = { [Op.between]: [new Date(startDate), new Date(endDate)] };
    }

    const payments = await Payment.findAll({
      where,
      include: [{ model: Student }]
    });

    const totalIncome = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);

    const expenses = await Expense.findAll({ where });
    const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount), 0);

    const incomeByMethod = {};
    payments.forEach(p => {
      if (!incomeByMethod[p.paymentMethod]) {
        incomeByMethod[p.paymentMethod] = 0;
      }
      incomeByMethod[p.paymentMethod] += parseFloat(p.amount);
    });

    const incomeByCategory = {};
    payments.forEach(p => {
      const category = p.isOtherIncome ? p.incomeCategory : 'Fee Payment';
      if (!incomeByCategory[category]) {
        incomeByCategory[category] = 0;
      }
      incomeByCategory[category] += parseFloat(p.amount);
    });

    const expensesByCategory = {};
    expenses.forEach(e => {
      if (!expensesByCategory[e.category]) {
        expensesByCategory[e.category] = 0;
      }
      expensesByCategory[e.category] += parseFloat(e.amount);
    });

    res.json({
      success: true,
      report: {
        period: { startDate, endDate },
        summary: {
          totalIncome,
          totalExpenses,
          netIncome: totalIncome - totalExpenses
        },
        incomeByMethod,
        incomeByCategory,
        expensesByCategory,
        payments,
        expenses
      }
    });
  } catch (error) {
    console.error('Generate financial report error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// ==================== MESSAGE ROUTES ====================

app.post('/api/messages', authenticate, async (req, res) => {
  try {
    const { type, subject, content, recipients, sendNow } = req.body;
    
    const message = await Message.create({
      type,
      subject,
      content,
      to: recipients,
      from: req.user.id,
      schoolId: req.user.schoolId,
      status: sendNow ? 'SENT' : 'DRAFT',
      sentAt: sendNow ? new Date() : null
    });

    console.log('Message created:', message.id);
    res.status(201).json({ success: true, message });
  } catch (error) {
    console.error('Create message error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ==================== DASHBOARD ROUTES ====================

app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    
    const stats = {
      overview: { totalStudents: 0, totalTeachers: 0, totalClasses: 0, totalStaff: 0 },
      attendance: { total: 0, present: 0, percentage: 0 },
      finance: { totalFees: 0, totalPayments: 0, balance: 0, collectionRate: 0 },
      alerts: { upcomingExams: 0, lowStock: 0, overdueBooks: 0, borrowedBooks: 0 },
      vehicles: { total: 0, active: 0, maintenance: 0, expiredInsurance: 0 },
      library: { totalBooks: 0, availableBooks: 0, borrowedBooks: 0 }
    };

    if (schoolId) {
      stats.overview.totalStudents = await Student.count({ where: { schoolId } }) || 0;
      stats.overview.totalTeachers = await User.count({ 
        where: { schoolId, role: ['TEACHER', 'CLASS_TEACHER', 'SUBJECT_TEACHER', 'SENIOR_TEACHER'] }
      }) || 0;
      stats.overview.totalClasses = await Class.count({ where: { schoolId } }) || 0;
      stats.overview.totalStaff = await Staff.count({ where: { schoolId } }) || 0;

      const books = await Book.findAll({ where: { schoolId } });
      stats.library.totalBooks = books.reduce((sum, b) => sum + b.quantity, 0);
      stats.library.availableBooks = books.reduce((sum, b) => sum + b.available, 0);
      stats.library.borrowedBooks = await Borrow.count({ 
        where: { status: 'BORROWED' },
        include: [{ model: Book, where: { schoolId } }]
      }) || 0;

      stats.vehicles.total = await Vehicle.count({ where: { schoolId } }) || 0;
      stats.vehicles.active = await Vehicle.count({ where: { schoolId, status: 'ACTIVE' } }) || 0;
      stats.vehicles.maintenance = await Vehicle.count({ where: { schoolId, status: 'MAINTENANCE' } }) || 0;
      stats.vehicles.expiredInsurance = await Vehicle.count({
        where: { 
          schoolId, 
          insuranceExpiry: { [Op.lt]: new Date() } 
        }
      }) || 0;

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayAttendance = await Attendance.findAll({
        where: { date: { [Op.between]: [today, tomorrow] } }
      });

      stats.attendance.total = todayAttendance.length;
      stats.attendance.present = todayAttendance.filter(a => a.status === 'PRESENT').length;
      stats.attendance.percentage = todayAttendance.length ? 
        ((stats.attendance.present / todayAttendance.length) * 100).toFixed(2) : 0;

      const totalFees = await Fee.sum('amount', { where: { schoolId } }) || 0;
      
      const payments = await Payment.findAll({
        include: [{
          model: Student,
          where: { schoolId },
          attributes: []
        }],
        attributes: [[sequelize.fn('SUM', sequelize.col('Payment.amount')), 'total']],
        raw: true
      });

      const totalPayments = parseFloat(payments[0]?.total) || 0;

      stats.finance.totalFees = totalFees;
      stats.finance.totalPayments = totalPayments;
      stats.finance.balance = totalFees - totalPayments;
      stats.finance.collectionRate = totalFees ? ((totalPayments / totalFees) * 100).toFixed(2) : 0;

      stats.alerts.upcomingExams = await Exam.count({
        where: { schoolId, date: { [Op.gte]: new Date() } }
      }) || 0;

      stats.alerts.lowStock = await Inventory.count({
        where: { schoolId, quantity: { [Op.lte]: sequelize.col('reorderLevel') } }
      }) || 0;

      stats.alerts.overdueBooks = await Borrow.count({
        where: { status: 'BORROWED', dueDate: { [Op.lt]: new Date() } },
        include: [{ model: Book, where: { schoolId } }]
      }) || 0;
      
      stats.alerts.borrowedBooks = await Borrow.count({
        where: { status: 'BORROWED' },
        include: [{ model: Book, where: { schoolId } }]
      }) || 0;
    }

    res.json({ success: true, stats });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

app.get('/api/dashboard/charts', authenticate, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;

    if (!schoolId) {
      return res.json({
        success: true,
        charts: {
          attendanceTrend: [],
          feeCollection: [],
          studentsByClass: []
        }
      });
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const attendanceTrend = await Attendance.findAll({
      where: { date: { [Op.gte]: thirtyDaysAgo } },
      attributes: [
        [sequelize.fn('DATE', sequelize.col('Attendance.date')), 'date'],
        'status',
        [sequelize.fn('COUNT', sequelize.col('Attendance.id')), 'count']
      ],
      group: ['date', 'status'],
      include: [{
        model: Student,
        where: { schoolId },
        attributes: [],
        required: true
      }]
    });

    const feeCollection = await Payment.findAll({
      where: { date: { [Op.gte]: thirtyDaysAgo } },
      attributes: [
        [sequelize.fn('DATE_TRUNC', 'month', sequelize.col('Payment.date')), 'month'],
        [sequelize.fn('SUM', sequelize.col('Payment.amount')), 'total']
      ],
      group: ['month'],
      include: [{
        model: Student,
        where: { schoolId },
        attributes: [],
        required: true
      }]
    });

    const studentsByClass = await Student.findAll({
      where: { schoolId },
      attributes: [
        'classId',
        [sequelize.fn('COUNT', sequelize.col('Student.id')), 'count']
      ],
      group: ['classId', 'Class.id', 'Class.name'],
      include: [{
        model: Class,
        attributes: ['name']
      }]
    });
    
    res.json({
      success: true,
      charts: {
        attendanceTrend: attendanceTrend || [],
        feeCollection: feeCollection || [],
        studentsByClass: studentsByClass || []
      }
    });
  } catch (error) {
    console.error('Charts data error:', error);
    res.json({
      success: true,
      charts: {
        attendanceTrend: [],
        feeCollection: [],
        studentsByClass: []
      }
    });
  }
});

// ==================== UPLOAD ROUTES ====================

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

app.post('/api/schools/upload-logo', authenticate, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    
    const logoUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, logoUrl });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/students/upload-photo', authenticate, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    
    const photoUrl = `/uploads/${req.file.filename}`;
    res.json({ success: true, photoUrl });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.use('/uploads', (req, res, next) => {
  const filePath = path.join(uploadDir, req.url);
  
  if (!fs.existsSync(filePath)) {
    return res.sendFile(path.join(publicDir, 'default-logo.svg'));
  }
  
  express.static(uploadDir)(req, res, next);
});

// ==================== UNIVERSITY/TVET ROUTES ====================
// ==================== FACULTIES ROUTE - MAKE SURE IT WORKS FOR ALL SCHOOL TYPES ====================
app.get('/api/faculties', authenticate, async (req, res) => {
  try {
    console.log(`📚 Fetching faculties for school: ${req.user.schoolId}`);
    
    const where = { schoolId: req.user.schoolId };
    const faculties = await Faculty.findAll({ 
      where,
      order: [['name', 'ASC']]
    });
    
    console.log(`✅ Found ${faculties.length} faculties`);
    
    res.json({ 
      success: true, 
      faculties,
      count: faculties.length
    });
  } catch (error) {
    console.error('❌ Get faculties error:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

app.post('/api/faculties', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, dean, email, phone, established } = req.body;
    
    const faculty = await Faculty.create({
      name,
      dean,
      email,
      phone,
      established,
      schoolId: req.user.schoolId
    });
    
    res.status(201).json({ success: true, faculty });
  } catch (error) {
    console.error('Create faculty error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/departments', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    const departments = await Department.findAll({ 
      where,
      include: [{ model: Faculty }]
    });
    res.json({ success: true, departments });
  } catch (error) {
    console.error('Get departments error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/departments', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, facultyId, head, email, phone } = req.body;
    
    const faculty = await Faculty.findOne({
      where: { id: facultyId, schoolId: req.user.schoolId }
    });
    
    if (!faculty) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faculty not found or does not belong to your school' 
      });
    }
    
    const department = await Department.create({
      name,
      facultyId,
      head,
      email,
      phone,
      schoolId: req.user.schoolId
    });
    
    const createdDept = await Department.findByPk(department.id, {
      include: [{ model: Faculty, attributes: ['id', 'name'] }]
    });
    
    res.status(201).json({ success: true, department: createdDept });
  } catch (error) {
    console.error('Create department error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/courses', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    const courses = await Course.findAll({ 
      where,
      include: [{ model: Department, include: [{ model: Faculty }] }]
    });
    res.json({ success: true, courses });
  } catch (error) {
    console.error('Get courses error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/courses', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, code, departmentId, credits, level, description } = req.body;
    
    const department = await Department.findOne({
      where: { id: departmentId, schoolId: req.user.schoolId }
    });
    
    if (!department) {
      return res.status(400).json({ message: 'Department not found' });
    }
    
    const course = await Course.create({
      name,
      code,
      departmentId,
      credits,
      level,
      description,
      schoolId: req.user.schoolId
    });
    
    const createdCourse = await Course.findByPk(course.id, {
      include: [{ model: Department }]
    });
    
    res.status(201).json({ success: true, course: createdCourse });
  } catch (error) {
    console.error('Create course error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== PROGRAMS ENDPOINTS (for TVET) ====================

// GET all programs
app.get('/api/programs', authenticate, async (req, res) => {
  try {
    const programs = await Program.findAll({
      where: { schoolId: req.user.schoolId },
      include: [{ model: Department, attributes: ['id', 'name'] }],
      order: [['name', 'ASC']]
    });
    
    res.json({ 
      success: true, 
      programs 
    });
  } catch (error) {
    console.error('❌ Get programs error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET single program by ID
app.get('/api/programs/:id', authenticate, async (req, res) => {
  try {
    const program = await Program.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [{ model: Department, attributes: ['id', 'name'] }]
    });
    
    if (!program) {
      return res.status(404).json({ 
        success: false, 
        message: 'Program not found' 
      });
    }
    
    res.json({ 
      success: true, 
      program 
    });
  } catch (error) {
    console.error('❌ Get program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// POST create new program
app.post('/api/programs', authenticate, async (req, res) => {
  try {
    const { name, code, departmentId, duration, level, description } = req.body;

    // Validate required fields
    if (!name || !code || !departmentId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Name, code, and department are required' 
      });
    }

    // Check if program with same code exists in this school
    const existing = await Program.findOne({
      where: { 
        code: code.toUpperCase(),
        schoolId: req.user.schoolId 
      }
    });

    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Program with this code already exists' 
      });
    }

    // Verify department exists and belongs to this school
    const department = await Department.findOne({
      where: { 
        id: departmentId,
        schoolId: req.user.schoolId 
      }
    });

    if (!department) {
      return res.status(400).json({ 
        success: false, 
        message: 'Department not found or does not belong to your school' 
      });
    }

    const program = await Program.create({
      name,
      code: code.toUpperCase(),
      departmentId,
      duration: duration || 3,
      level: level || 'Diploma',
      description,
      schoolId: req.user.schoolId
    });

    // Fetch with department info
    const createdProgram = await Program.findByPk(program.id, {
      include: [{ model: Department, attributes: ['id', 'name'] }]
    });

    await createAuditLog(req, 'CREATE', 'PROGRAM', program.id, null, createdProgram);

    res.status(201).json({ 
      success: true, 
      program: createdProgram 
    });
  } catch (error) {
    console.error('❌ Create program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// PUT update program
app.put('/api/programs/:id', authenticate, async (req, res) => {
  try {
    const program = await Program.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });

    if (!program) {
      return res.status(404).json({ 
        success: false, 
        message: 'Program not found' 
      });
    }

    const { name, code, departmentId, duration, level, description } = req.body;

    // If code is being changed, check for duplicates
    if (code && code.toUpperCase() !== program.code) {
      const existing = await Program.findOne({
        where: { 
          code: code.toUpperCase(),
          schoolId: req.user.schoolId,
          id: { [Op.ne]: program.id }
        }
      });

      if (existing) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program with this code already exists' 
        });
      }
    }

    // If department is being changed, verify it exists
    if (departmentId && departmentId !== program.departmentId) {
      const department = await Department.findOne({
        where: { 
          id: departmentId,
          schoolId: req.user.schoolId 
        }
      });

      if (!department) {
        return res.status(400).json({ 
          success: false, 
          message: 'Department not found or does not belong to your school' 
        });
      }
    }

    const oldProgram = { ...program.toJSON() };

    await program.update({
      name: name || program.name,
      code: code ? code.toUpperCase() : program.code,
      departmentId: departmentId || program.departmentId,
      duration: duration !== undefined ? duration : program.duration,
      level: level || program.level,
      description: description !== undefined ? description : program.description
    });

    // Fetch updated program with department
    const updatedProgram = await Program.findByPk(program.id, {
      include: [{ model: Department, attributes: ['id', 'name'] }]
    });

    await createAuditLog(req, 'UPDATE', 'PROGRAM', program.id, oldProgram, updatedProgram);

    res.json({ 
      success: true, 
      program: updatedProgram 
    });
  } catch (error) {
    console.error('❌ Update program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE program
app.delete('/api/programs/:id', authenticate, async (req, res) => {
  try {
    const program = await Program.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });

    if (!program) {
      return res.status(404).json({ 
        success: false, 
        message: 'Program not found' 
      });
    }

    // Check if program has students enrolled
    const studentsCount = await Student.count({
      where: { programId: program.id }
    });

    if (studentsCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete program with ${studentsCount} enrolled students. Please reassign students first.` 
      });
    }

    // Check if program has units/modules
    const unitsCount = await CourseUnit.count({
      where: { programId: program.id }
    });

    if (unitsCount > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete program with ${unitsCount} units/modules. Please delete units first.` 
      });
    }

    await program.destroy();
    await createAuditLog(req, 'DELETE', 'PROGRAM', req.params.id);

    res.json({ 
      success: true, 
      message: 'Program deleted successfully' 
    });
  } catch (error) {
    console.error('❌ Delete program error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET programs by department
app.get('/api/departments/:departmentId/programs', authenticate, async (req, res) => {
  try {
    const { departmentId } = req.params;

    // Verify department belongs to this school
    const department = await Department.findOne({
      where: { 
        id: departmentId,
        schoolId: req.user.schoolId 
      }
    });

    if (!department) {
      return res.status(404).json({ 
        success: false, 
        message: 'Department not found' 
      });
    }

    const programs = await Program.findAll({
      where: { 
        departmentId,
        schoolId: req.user.schoolId 
      },
      order: [['name', 'ASC']]
    });

    res.json({ 
      success: true, 
      programs,
      department: {
        id: department.id,
        name: department.name
      }
    });
  } catch (error) {
    console.error('❌ Get department programs error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.get('/api/course-units', authenticate, async (req, res) => {
  try {
    const { courseId } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (courseId) {
      where.courseId = courseId;
    }

    const units = await CourseUnit.findAll({
      where,
      include: [{ model: Course, attributes: ['id', 'name', 'code'] }],
      order: [['year', 'ASC'], ['semester', 'ASC'], ['name', 'ASC']]
    });
    
    res.json({ success: true, units });
  } catch (error) {
    console.error('Get course units error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/course-units', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT CREATE ==========');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  
  try {
    const { name, code, courseId, programId, semester, module, year, credits, description } = req.body;

    // Validate that either courseId or programId is provided
    if (!courseId && !programId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Either courseId or programId is required' 
      });
    }

    // Get school to determine category
    const school = await School.findByPk(req.user.schoolId);
    if (!school) {
      return res.status(400).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    const isUniversity = school.category === 'UNIVERSITY';
    const isTVET = school.category === 'COLLEGE_TVET';

    // Prepare data
    const unitData = {
      name: name.trim(),
      code: code?.trim() || null,
      courseId: isUniversity ? courseId : null,
      programId: isTVET ? programId : null,
      year: year ? parseInt(year) : null,
      credits: credits ? parseInt(credits) : 3,
      description: description?.trim() || null,
      schoolId: req.user.schoolId
    };

    // Handle semester for University
    if (isUniversity) {
      unitData.semester = semester ? parseInt(semester) : null;
      unitData.module = null;
      console.log('🏫 University: setting semester to', unitData.semester);
    }
    // Handle module for TVET
    else if (isTVET) {
      unitData.module = module ? parseInt(module) : null;
      unitData.semester = null;
      console.log('🔧 TVET: setting module to', unitData.module);
    }
    // Handle other school types
    else {
      unitData.semester = semester ? parseInt(semester) : null;
      unitData.module = module ? parseInt(module) : null;
    }

    console.log('Creating unit with data:', unitData);

    // Verify course exists if provided
    if (unitData.courseId) {
      const course = await Course.findOne({
        where: { id: unitData.courseId, schoolId: req.user.schoolId }
      });
      if (!course) {
        return res.status(400).json({ 
          success: false, 
          message: 'Course not found or does not belong to your school' 
        });
      }
    }

    // Verify program exists if provided
    if (unitData.programId) {
      const program = await Program.findOne({
        where: { id: unitData.programId, schoolId: req.user.schoolId }
      });
      if (!program) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program not found or does not belong to your school' 
        });
      }
    }

    // Create the unit
    const unit = await CourseUnit.create(unitData);

    await createAuditLog(req, 'CREATE', 'COURSE_UNIT', unit.id, null, unit);

    // Fetch the created unit with appropriate includes
    const include = [];
    if (unit.courseId) {
      include.push({ model: Course, attributes: ['id', 'name', 'code'] });
    }
    if (unit.programId) {
      include.push({ model: Program, attributes: ['id', 'name', 'code'] });
    }

    const createdUnit = await CourseUnit.findByPk(unit.id, { include });

    console.log('✅ Unit created successfully');
    res.status(201).json({ success: true, unit: createdUnit });

  } catch (error) {
    console.error('❌ Create course unit error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ==================== COURSE UNITS ENDPOINTS ====================

// GET all course units
app.get('/api/course-units', authenticate, async (req, res) => {
  try {
    const { courseId } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (courseId) {
      where.courseId = courseId;
    }

    const units = await CourseUnit.findAll({
      where,
      include: [{ 
        model: Course, 
        attributes: ['id', 'name', 'code', 'departmentId'] 
      }],
      order: [
        ['year', 'ASC'],
        ['semester', 'ASC'],
        ['module', 'ASC'],
        ['name', 'ASC']
      ]
    });
    
    // Log for debugging
    console.log(`📚 Found ${units.length} units`);
    if (units.length > 0) {
      console.log('Sample unit:', {
        id: units[0].id,
        name: units[0].name,
        semester: units[0].semester,
        module: units[0].module,
        year: units[0].year
      });
    }
    
    res.json({ 
      success: true, 
      units,
      count: units.length
    });
  } catch (error) {
    console.error('❌ Get course units error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// GET single course unit by ID
app.get('/api/course-units/:id', authenticate, async (req, res) => {
  try {
    const unit = await CourseUnit.findOne({
      where: { 
        id: req.params.id, 
        schoolId: req.user.schoolId 
      },
      include: [{ 
        model: Course, 
        attributes: ['id', 'name', 'code', 'departmentId'] 
      }]
    });
    
    if (!unit) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course unit not found' 
      });
    }
    
    console.log('📚 Retrieved unit:', {
      id: unit.id,
      name: unit.name,
      semester: unit.semester,
      module: unit.module
    });
    
    res.json({ 
      success: true, 
      unit 
    });
  } catch (error) {
    console.error('❌ Get course unit error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// CREATE new course unit
app.post('/api/course-units', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT CREATE ==========');
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('User school ID:', req.user.schoolId);
  
  try {
    const { name, code, courseId, semester, module, year, credits, description } = req.body;

    // Validate required fields
    if (!name) {
      return res.status(400).json({ 
        success: false, 
        message: 'Unit name is required' 
      });
    }

    if (!courseId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Course ID is required' 
      });
    }

    // Verify course exists and belongs to this school
    const course = await Course.findOne({
      where: { 
        id: courseId, 
        schoolId: req.user.schoolId 
      }
    });

    if (!course) {
      return res.status(400).json({ 
        success: false, 
        message: 'Course not found or does not belong to your school' 
      });
    }

    // Get school to determine category
    const school = await School.findByPk(req.user.schoolId);
    if (!school) {
      return res.status(400).json({ 
        success: false, 
        message: 'School not found' 
      });
    }

    const isUniversity = school.category === 'UNIVERSITY';
    const isTVET = school.category === 'COLLEGE_TVET';

    console.log(`🏫 School category: ${school.category}`);
    console.log(`📚 University: ${isUniversity}, TVET: ${isTVET}`);

    // Prepare data with proper handling of semester/module
    const unitData = {
      name: name.trim(),
      code: code?.trim() || null,
      courseId,
      year: year ? parseInt(year) : null,
      credits: credits ? parseInt(credits) : 3,
      description: description?.trim() || null,
      schoolId: req.user.schoolId
    };

    // Handle semester for University
    if (isUniversity) {
      unitData.semester = semester ? parseInt(semester) : null;
      unitData.module = null;
      console.log('🏫 University: setting semester to', unitData.semester);
    }
    // Handle module for TVET
    else if (isTVET) {
      unitData.module = module ? parseInt(module) : null;
      unitData.semester = null;
      console.log('🔧 TVET: setting module to', unitData.module);
    }
    // Handle other school types (fallback)
    else {
      unitData.semester = semester ? parseInt(semester) : null;
      unitData.module = module ? parseInt(module) : null;
      console.log('📚 Other school type: setting both fields');
    }

    // Remove undefined fields
    Object.keys(unitData).forEach(key => {
      if (unitData[key] === undefined) delete unitData[key];
    });

    console.log('Creating unit with data:', unitData);

    // Create the unit
    const unit = await CourseUnit.create(unitData);

    console.log('✅ Unit created in database:', {
      id: unit.id,
      name: unit.name,
      semester: unit.semester,
      module: unit.module,
      year: unit.year,
      credits: unit.credits,
      schoolId: unit.schoolId
    });

    // Create audit log
    await createAuditLog(req, 'CREATE', 'COURSE_UNIT', unit.id, null, unit);

    // Fetch the created unit with course info
    const createdUnit = await CourseUnit.findByPk(unit.id, {
      include: [{ 
        model: Course, 
        attributes: ['id', 'name', 'code'] 
      }]
    });

    // Double-check the fetched unit has all fields
    console.log('✅ Unit fetched from DB for response:', {
      id: createdUnit.id,
      name: createdUnit.name,
      semester: createdUnit.semester,
      module: createdUnit.module,
      year: createdUnit.year,
      credits: createdUnit.credits,
      course: createdUnit.Course ? createdUnit.Course.name : null
    });

    // If module is missing in the response but exists in DB, add it manually
    if (isTVET && unitData.module && createdUnit.module === null) {
      console.warn('⚠️ Module missing in response, adding manually');
      createdUnit.module = unitData.module;
    }

    res.status(201).json({ 
      success: true, 
      unit: createdUnit 
    });

  } catch (error) {
    console.error('❌ Create course unit error:', error);
    
    // Handle specific Sequelize errors
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({ 
        success: false, 
        message: 'Validation error', 
        errors: error.errors.map(e => e.message) 
      });
    }
    
    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ 
        success: false, 
        message: 'A unit with this code already exists' 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// UPDATE course unit
app.put('/api/course-units/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT UPDATE ==========');
  console.log('Params ID:', req.params.id);
  console.log('Request body:', JSON.stringify(req.body, null, 2));
  console.log('School ID:', req.user.schoolId);
  
  try {
    const { id } = req.params;
    const updates = req.body;

    // Find the unit
    const unit = await CourseUnit.findOne({
      where: { 
        id: id,
        schoolId: req.user.schoolId 
      }
    });

    if (!unit) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course unit not found' 
      });
    }

    console.log('Current unit:', {
      id: unit.id,
      name: unit.name,
      semester: unit.semester,
      module: unit.module,
      year: unit.year,
      credits: unit.credits
    });

    // Get school to determine category
    const school = await School.findByPk(req.user.schoolId);
    const isUniversity = school.category === 'UNIVERSITY';
    const isTVET = school.category === 'COLLEGE_TVET';

    // Prepare update data
    const updateData = {};
    
    // Handle string fields
    if (updates.name !== undefined) updateData.name = updates.name.trim();
    if (updates.code !== undefined) updateData.code = updates.code?.trim() || null;
    if (updates.description !== undefined) updateData.description = updates.description?.trim() || null;
    if (updates.courseId !== undefined) {
      // Verify course exists if changing
      const course = await Course.findOne({
        where: { id: updates.courseId, schoolId: req.user.schoolId }
      });
      if (!course) {
        return res.status(400).json({ 
          success: false, 
          message: 'Course not found or does not belong to your school' 
        });
      }
      updateData.courseId = updates.courseId;
    }
    
    // Handle semester for University
    if (isUniversity) {
      if (updates.semester !== undefined) {
        updateData.semester = updates.semester === '' || updates.semester === null 
          ? null 
          : parseInt(updates.semester);
        updateData.module = null; // Ensure module is null for university
      }
      console.log('🏫 University update: semester ->', updateData.semester);
    }
    // Handle module for TVET
    else if (isTVET) {
      if (updates.module !== undefined) {
        updateData.module = updates.module === '' || updates.module === null 
          ? null 
          : parseInt(updates.module);
        updateData.semester = null; // Ensure semester is null for TVET
      }
      console.log('🔧 TVET update: module ->', updateData.module);
    }
    // Handle other school types
    else {
      if (updates.semester !== undefined) {
        updateData.semester = updates.semester === '' || updates.semester === null 
          ? null 
          : parseInt(updates.semester);
      }
      if (updates.module !== undefined) {
        updateData.module = updates.module === '' || updates.module === null 
          ? null 
          : parseInt(updates.module);
      }
    }
    
    // Handle year
    if (updates.year !== undefined) {
      updateData.year = updates.year === '' || updates.year === null 
        ? null 
        : parseInt(updates.year);
    }
    
    // Handle credits
    if (updates.credits !== undefined) {
      const creditsNum = parseInt(updates.credits);
      updateData.credits = isNaN(creditsNum) ? 3 : creditsNum;
    }

    // Remove undefined fields
    Object.keys(updateData).forEach(key => {
      if (updateData[key] === undefined) delete updateData[key];
    });

    console.log('Final update data:', updateData);

    // Perform the update
    await unit.update(updateData);

    // Create audit log
    await createAuditLog(req, 'UPDATE', 'COURSE_UNIT', unit.id, null, unit);

    // Fetch the updated unit
    const updatedUnit = await CourseUnit.findByPk(unit.id, {
      include: [{ 
        model: Course, 
        attributes: ['id', 'name', 'code'],
        required: false 
      }]
    });

    console.log('✅ Update successful');
    console.log('Updated unit:', {
      id: updatedUnit.id,
      name: updatedUnit.name,
      semester: updatedUnit.semester,
      module: updatedUnit.module,
      year: updatedUnit.year,
      credits: updatedUnit.credits
    });
    
    res.json({ 
      success: true, 
      unit: updatedUnit 
    });

  } catch (error) {
    console.error('❌ Error updating course unit:', error);
    
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// DELETE course unit
app.delete('/api/course-units/:id', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT DELETE ==========');
  console.log('Params ID:', req.params.id);
  
  try {
    const { id } = req.params;

    // Find the unit
    const unit = await CourseUnit.findOne({
      where: { 
        id: id,
        schoolId: req.user.schoolId 
      }
    });

    if (!unit) {
      return res.status(404).json({ 
        success: false, 
        message: 'Course unit not found' 
      });
    }

    console.log('Found unit to delete:', {
      id: unit.id,
      name: unit.name,
      semester: unit.semester,
      module: unit.module
    });

    // Check if this unit is used in any exams
    const examsUsingUnit = await Exam.count({
      where: { unitId: id }
    });

    if (examsUsingUnit > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete unit because it is used in ${examsUsingUnit} exam(s). Please remove those exams first.` 
      });
    }

    // Check if this unit is used in any timetable entries
    const timetableEntries = await Timetable.count({
      where: { unitId: id }
    });

    if (timetableEntries > 0) {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot delete unit because it is used in ${timetableEntries} timetable entry(s). Please remove those entries first.` 
      });
    }

    // Delete the unit
    await unit.destroy();

    // Create audit log
    await createAuditLog(req, 'DELETE', 'COURSE_UNIT', id, null, null);

    console.log('✅ Course unit deleted successfully');
    res.json({ 
      success: true, 
      message: 'Course unit deleted successfully' 
    });

  } catch (error) {
    console.error('❌ Error deleting course unit:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// BULK CREATE course units (for importing)
app.post('/api/course-units/bulk', authenticate, requireSchoolAdmin, async (req, res) => {
  console.log('\n========== COURSE UNIT BULK CREATE ==========');
  
  try {
    const { units } = req.body;
    
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide an array of units' 
      });
    }

    // Get school to determine category
    const school = await School.findByPk(req.user.schoolId);
    const isUniversity = school.category === 'UNIVERSITY';
    const isTVET = school.category === 'COLLEGE_TVET';

    const createdUnits = [];
    const errors = [];

    for (const unitData of units) {
      try {
        // Verify course exists
        const course = await Course.findOne({
          where: { 
            id: unitData.courseId, 
            schoolId: req.user.schoolId 
          }
        });

        if (!course) {
          errors.push({ 
            data: unitData, 
            error: `Course ${unitData.courseId} not found` 
          });
          continue;
        }

        // Prepare data with proper handling
        const data = {
          name: unitData.name?.trim(),
          code: unitData.code?.trim() || null,
          courseId: unitData.courseId,
          year: unitData.year ? parseInt(unitData.year) : null,
          credits: unitData.credits ? parseInt(unitData.credits) : 3,
          description: unitData.description?.trim() || null,
          schoolId: req.user.schoolId
        };

        // Handle semester/module based on school type
        if (isUniversity) {
          data.semester = unitData.semester ? parseInt(unitData.semester) : null;
          data.module = null;
        } else if (isTVET) {
          data.module = unitData.module ? parseInt(unitData.module) : null;
          data.semester = null;
        } else {
          data.semester = unitData.semester ? parseInt(unitData.semester) : null;
          data.module = unitData.module ? parseInt(unitData.module) : null;
        }

        const unit = await CourseUnit.create(data);
        
        const createdUnit = await CourseUnit.findByPk(unit.id, {
          include: [{ model: Course, attributes: ['id', 'name', 'code'] }]
        });
        
        createdUnits.push(createdUnit);
        
      } catch (err) {
        console.error('Error creating unit:', err);
        errors.push({ 
          data: unitData, 
          error: err.message 
        });
      }
    }

    await createAuditLog(req, 'BULK_CREATE', 'COURSE_UNIT', null, null, { 
      count: createdUnits.length,
      errors: errors.length 
    });

    console.log(`✅ Created ${createdUnits.length} units, ${errors.length} errors`);
    
    res.status(201).json({ 
      success: true, 
      units: createdUnits,
      errors: errors.length > 0 ? errors : undefined,
      summary: {
        created: createdUnits.length,
        failed: errors.length,
        total: units.length
      }
    });

  } catch (error) {
    console.error('❌ Bulk create course units error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
app.get('/api/labs', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    const labs = await Lab.findAll({ 
      where,
      include: [{ model: Department }]
    });
    res.json({ success: true, labs });
  } catch (error) {
    console.error('Get labs error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/labs', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { name, departmentId, incharge, capacity, location } = req.body;
    
    const department = await Department.findOne({
      where: { id: departmentId, schoolId: req.user.schoolId }
    });
    
    if (!department) {
      return res.status(400).json({ message: 'Department not found' });
    }
    
    const lab = await Lab.create({
      name,
      departmentId,
      incharge,
      capacity,
      location,
      schoolId: req.user.schoolId
    });
    
    const createdLab = await Lab.findByPk(lab.id, {
      include: [{ model: Department }]
    });
    
    res.status(201).json({ success: true, lab: createdLab });
  } catch (error) {
    console.error('Create lab error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.get('/api/research', authenticate, async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    const research = await Research.findAll({ 
      where,
      include: [{ model: Faculty }]
    });
    res.json({ success: true, research });
  } catch (error) {
    console.error('Get research error:', error);
    res.status(500).json({ message: error.message });
  }
});

app.post('/api/research', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { title, facultyId, researcher, startDate, endDate, funding, status } = req.body;
    
    const faculty = await Faculty.findOne({
      where: { id: facultyId, schoolId: req.user.schoolId }
    });
    
    if (!faculty) {
      return res.status(400).json({ message: 'Faculty not found' });
    }
    
    const research = await Research.create({
      title,
      facultyId,
      researcher,
      startDate,
      endDate,
      funding,
      status,
      schoolId: req.user.schoolId
    });
    
    const createdResearch = await Research.findByPk(research.id, {
      include: [{ model: Faculty }]
    });
    
    res.status(201).json({ success: true, research: createdResearch });
  } catch (error) {
    console.error('Create research error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== FEE REMINDERS ROUTE ====================

app.post('/api/fee-reminders/send', authenticate, async (req, res) => {
  try {
    const { classId, specificStudents, courseId } = req.body;
    
    const school = await School.findByPk(req.user.schoolId);
    
    let where = { schoolId: req.user.schoolId };
    
    if (school.category === 'UNIVERSITY') {
      if (courseId) where.courseId = courseId;
    } else {
      if (classId) where.classId = classId;
    }
    
    const students = specificStudents 
      ? await Student.findAll({ where: { id: specificStudents } })
      : await Student.findAll({ where });
    
    const reminders = [];
    
    for (const student of students) {
      let feeWhere = { schoolId: req.user.schoolId };
      
      if (school.category === 'UNIVERSITY') {
        feeWhere.courseId = student.courseId;
        feeWhere.year = student.currentYear;
      } else if (school.category === 'COLLEGE_TVET') {
        feeWhere.programId = student.programId;
      } else {
        feeWhere.classId = student.classId;
      }
      
      const totalFees = await Fee.sum('amount', { where: feeWhere }) || 0;
      
      const payments = await Payment.sum('amount', {
        where: { studentId: student.id }
      }) || 0;
      
      const balance = totalFees - payments;
      
      if (balance > 0) {
        const parents = await Parent.findAll({
          where: { studentId: student.id },
          include: [{ model: User }]
        });
        
        for (const parent of parents) {
          if (parent.User && parent.User.phone) {
            const message = {
              type: 'SMS',
              to: parent.User.phone,
              content: `Fee reminder for ${student.firstName} ${student.lastName}: Balance KES ${balance}. Due date: ${new Date().toLocaleDateString()}`,
              schoolId: req.user.schoolId
            };
            
            await Message.create(message);
            reminders.push({ student: student.id, parent: parent.User.phone, balance });
          }
        }
      }
    }
    
    res.json({ success: true, remindersSent: reminders.length, reminders });
  } catch (error) {
    console.error('Send reminders error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== STAFF ATTENDANCE ROUTES ====================
// ==================== UPDATED STAFF ATTENDANCE ROUTES ====================

// ==================== STAFF ATTENDANCE APPROVAL ENDPOINTS ====================

// Get pending approvals (HR/Admin only)
app.get('/api/staff-attendance/pending', authenticate, async (req, res) => {
  try {
    // Check if user has HR/Admin permissions
    const canApprove = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL', 'HR_MANAGER', 'HR'].includes(req.user.role);
    
    if (!canApprove) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. HR/Admin only.' 
      });
    }

    const { department } = req.query;
    
    let where = { 
      approvalStatus: 'PENDING',
      approved: false
    };

    let include = [{
      model: Staff,
      where: { schoolId: req.user.schoolId }, // Filter by current school
      include: [{ 
        model: User, 
        attributes: ['firstName', 'lastName', 'email', 'phone'] 
      }]
    }];

    // Filter by department if specified
    if (department) {
      include[0].where.department = department;
    }

    const pending = await StaffAttendance.findAll({
      where,
      include,
      order: [['date', 'DESC'], ['createdAt', 'DESC']]
    });

    res.json({ 
      success: true, 
      pending,
      count: pending.length
    });
  } catch (error) {
    console.error('❌ Error fetching pending approvals:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// Approve/Reject attendance (HR/Admin only)
app.patch('/api/staff-attendance/:id/approve', authenticate, async (req, res) => {
  try {
    // Check if user has HR/Admin permissions
    const canApprove = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'DEPUTY_PRINCIPAL', 'HR_MANAGER', 'HR'].includes(req.user.role);
    
    if (!canApprove) {
      return res.status(403).json({ 
        success: false, 
        message: 'Access denied. HR/Admin only.' 
      });
    }

    const { action } = req.body; // 'APPROVE' or 'REJECT'
    
    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Action must be APPROVE or REJECT' 
      });
    }

    const attendance = await StaffAttendance.findOne({
      where: { 
        id: req.params.id,
        approvalStatus: 'PENDING'
      },
      include: [{ 
        model: Staff, 
        where: { schoolId: req.user.schoolId }, // Ensure belongs to this school
        include: [{ model: User }] 
      }]
    });

    if (!attendance) {
      return res.status(404).json({ 
        success: false, 
        message: 'Pending attendance record not found' 
      });
    }

    const oldValue = { ...attendance.toJSON() };
    
    if (action === 'APPROVE') {
      await attendance.update({ 
        approved: true, 
        approvalStatus: 'APPROVED',
        approvedBy: req.user.id,
        approvedAt: new Date()
      });
    } else if (action === 'REJECT') {
      await attendance.update({ 
        approved: false, 
        approvalStatus: 'REJECTED',
        approvedBy: req.user.id,
        approvedAt: new Date()
      });
    }

    // Create audit log
    await createAuditLog(req, action, 'STAFF_ATTENDANCE', attendance.id, oldValue, attendance);

    res.json({ 
      success: true, 
      attendance,
      message: `Attendance ${action.toLowerCase()}d successfully`
    });
  } catch (error) {
    console.error('❌ Error approving attendance:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// Get my pending requests (for staff to see their pending approvals)
app.get('/api/staff-attendance/my-pending', authenticate, async (req, res) => {
  try {
    const staff = await Staff.findOne({ 
      where: { 
        userId: req.user.id,
        schoolId: req.user.schoolId 
      } 
    });
    
    if (!staff) {
      return res.status(404).json({ 
        success: false, 
        message: 'Staff record not found' 
      });
    }

    const pending = await StaffAttendance.findAll({
      where: { 
        staffId: staff.id,
        approvalStatus: 'PENDING'
      },
      order: [['date', 'DESC']]
    });

    res.json({ 
      success: true, 
      pending,
      count: pending.length
    });
  } catch (error) {
    console.error('❌ Error fetching my pending requests:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// Bulk create/update with approval (Admin direct marking)
app.post('/api/staff-attendance/bulk', authenticate, async (req, res) => {
  try {
    // Check if user has permission
    const canMarkDirectly = ['SUPER_ADMIN', 'SCHOOL_ADMIN', 'PRINCIPAL', 'HR_MANAGER'].includes(req.user.role);
    
    const records = req.body;
    const created = [];
    const errors = [];

    for (const record of records) {
      try {
        // Verify staff belongs to this school
        const staff = await Staff.findOne({
          where: { 
            id: record.staffId,
            schoolId: req.user.schoolId 
          }
        });

        if (!staff) {
          errors.push({ record, error: 'Staff not found in your school' });
          continue;
        }

        // Check for existing record
        const existing = await StaffAttendance.findOne({
          where: { 
            staffId: record.staffId,
            date: record.date
          }
        });

        const attendanceData = {
          staffId: record.staffId,
          date: record.date,
          status: record.status,
          timeIn: record.timeIn || null,
          timeOut: record.timeOut || null,
          remarks: record.remarks || '',
          markedBy: req.user.id,
          // Admin marks are auto-approved
          approved: canMarkDirectly,
          approvalStatus: canMarkDirectly ? 'APPROVED' : 'PENDING'
        };

        if (existing) {
          // Update existing
          await existing.update(attendanceData);
          created.push(existing);
        } else {
          // Create new
          const newRecord = await StaffAttendance.create(attendanceData);
          created.push(newRecord);
        }
      } catch (err) {
        console.error('Error processing record:', err);
        errors.push({ record, error: err.message });
      }
    }

    res.json({ 
      success: true, 
      attendance: created,
      errors: errors.length > 0 ? errors : undefined,
      message: `Processed ${created.length} records with ${errors.length} errors`
    });
  } catch (error) {
    console.error('❌ Error saving staff attendance:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// Update the existing GET /api/staff-attendance to include approval status
app.get('/api/staff-attendance', authenticate, async (req, res) => {
  try {
    const { date, staffId, startDate, endDate, department, approvalStatus } = req.query;
    const where = {};

    if (date) where.date = date;
    if (staffId) where.staffId = staffId;
    if (approvalStatus) where.approvalStatus = approvalStatus;
    
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }

    let include = [{
      model: Staff,
      where: { schoolId: req.user.schoolId }, // Filter by school
      include: [{ 
        model: User, 
        attributes: ['firstName', 'lastName', 'email', 'phone'] 
      }]
    }];

    if (department) {
      include[0].where.department = department;
    }

    const attendance = await StaffAttendance.findAll({
      where,
      include,
      order: [['date', 'DESC'], ['createdAt', 'DESC']]
    });

    res.json({ 
      success: true, 
      attendance 
    });
  } catch (error) {
    console.error('❌ Error fetching staff attendance:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// Update the report endpoint to include approval stats
app.get('/api/staff-attendance/report', authenticate, async (req, res) => {
  try {
    const { startDate, endDate, department, staffId } = req.query;
    
    const where = {};
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }
    if (staffId) where.staffId = staffId;

    let include = [{
      model: Staff,
      where: { schoolId: req.user.schoolId }, // Filter by school
      include: [{ 
        model: User, 
        attributes: ['firstName', 'lastName'] 
      }]
    }];

    if (department) {
      include[0].where.department = department;
    }

    const attendance = await StaffAttendance.findAll({
      where,
      include,
      order: [['date', 'DESC'], ['createdAt', 'DESC']]
    });

    // Calculate summary including approval stats
    const totalDays = [...new Set(attendance.map(a => a.date))].length;
    const totalStaff = [...new Set(attendance.map(a => a.staffId))].length;
    
    const totalPresent = attendance.filter(a => a.status === 'PRESENT' && a.approved).length;
    const totalAbsent = attendance.filter(a => a.status === 'ABSENT' && a.approved).length;
    const totalLate = attendance.filter(a => a.status === 'LATE' && a.approved).length;
    const totalLeave = attendance.filter(a => a.status === 'LEAVE' && a.approved).length;
    const pendingApprovals = attendance.filter(a => a.approvalStatus === 'PENDING').length;
    const rejectedApprovals = attendance.filter(a => a.approvalStatus === 'REJECTED').length;
    
    // Department breakdown
    const byDepartment = {};
    attendance.forEach(record => {
      if (record.approved) {
        const dept = record.Staff?.department || 'No Department';
        if (!byDepartment[dept]) {
          byDepartment[dept] = { total: 0, present: 0 };
        }
        byDepartment[dept].total++;
        if (record.status === 'PRESENT') byDepartment[dept].present++;
      }
    });

    const deptBreakdown = Object.entries(byDepartment).map(([dept, data]) => ({
      department: dept,
      ...data,
      percentage: data.total ? ((data.present / data.total) * 100).toFixed(1) : 0
    }));

    // Daily trend
    const dailyTrend = {};
    attendance.forEach(record => {
      if (!dailyTrend[record.date]) {
        dailyTrend[record.date] = { 
          date: record.date, 
          total: 0, 
          present: 0, 
          absent: 0, 
          late: 0, 
          leave: 0,
          pending: 0,
          rejected: 0
        };
      }
      dailyTrend[record.date].total++;
      dailyTrend[record.date][record.status.toLowerCase()]++;
      
      if (record.approvalStatus === 'PENDING') dailyTrend[record.date].pending++;
      if (record.approvalStatus === 'REJECTED') dailyTrend[record.date].rejected++;
    });

    const trend = Object.values(dailyTrend).map(day => ({
      ...day,
      rate: day.total ? ((day.present / day.total) * 100).toFixed(1) : 0
    }));

    res.json({
      success: true,
      attendance,
      summary: {
        totalDays,
        totalStaff,
        totalPresent,
        totalAbsent,
        totalLate,
        totalLeave,
        pendingApprovals,
        rejectedApprovals,
        presentPercentage: totalDays ? ((totalPresent / (totalDays * totalStaff)) * 100).toFixed(1) : 0,
        byDepartment: deptBreakdown,
        dailyTrend: trend
      }
    });
  } catch (error) {
    console.error('❌ Staff attendance report error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});

// Self-mark attendance (staff marking their own)
app.post('/api/staff-attendance/self', authenticate, async (req, res) => {
  try {
    const { date, status, timeIn, remarks } = req.body;
    
    // Find the staff record for this user
    const staff = await Staff.findOne({ 
      where: { 
        userId: req.user.id,
        schoolId: req.user.schoolId 
      } 
    });
    
    if (!staff) {
      return res.status(404).json({ 
        success: false, 
        message: 'Staff record not found for this user' 
      });
    }

    // Check if already marked for this date
    const existing = await StaffAttendance.findOne({
      where: { staffId: staff.id, date }
    });

    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Attendance already marked for this date',
        attendance: existing
      });
    }

    // Create attendance record with pending approval
    const attendance = await StaffAttendance.create({
      staffId: staff.id,
      date,
      status,
      timeIn: timeIn || null,
      remarks: remarks || '',
      markedBy: req.user.id,
      approved: false,
      approvalStatus: 'PENDING'
    });

    await createAuditLog(req, 'SELF_MARK', 'STAFF_ATTENDANCE', attendance.id, null, attendance);

    res.status(201).json({ 
      success: true, 
      attendance,
      message: 'Attendance marked successfully. Pending approval.'
    });
  } catch (error) {
    console.error('❌ Error self-marking attendance:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error', 
      error: error.message 
    });
  }
});
// ADD THESE ROUTES to your backend:

// GET /api/features - Get all features for a school
app.get('/api/features', authenticate, async (req, res) => {
  try {
    const features = await Feature.findAll({
      where: { schoolId: req.user.schoolId }
    });
    
    res.json({ success: true, features });
  } catch (error) {
    console.error('Get features error:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/features/:code/toggle - Toggle feature on/off
app.patch('/api/features/:code/toggle', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const [feature, created] = await Feature.findOrCreate({
      where: { code: req.params.code, schoolId: req.user.schoolId },
      defaults: {
        name: req.params.code,
        code: req.params.code,
        category: 'GENERAL',
        isEnabled: true,
        schoolId: req.user.schoolId
      }
    });

    if (!created) {
      await feature.update({ isEnabled: !feature.isEnabled });
    }

    res.json({ success: true, feature });
  } catch (error) {
    console.error('Toggle feature error:', error);
    res.status(500).json({ message: error.message });
  }
});
// ADD THESE ROUTES:

// GET /api/settings/notifications - Get notification settings
app.get('/api/settings/notifications', authenticate, async (req, res) => {
  try {
    // You can create a NotificationSettings model or store in school settings
    const school = await School.findByPk(req.user.schoolId);
    
    const notifications = [
      { 
        id: 'fee-reminders', 
        name: 'Fee Reminders', 
        description: 'Send reminders to parents about overdue fees',
        enabled: school?.settings?.notifications?.feeReminders ?? true 
      },
      { 
        id: 'exam-results', 
        name: 'Exam Results Published', 
        description: 'Notify parents when results are published',
        enabled: school?.settings?.notifications?.examResults ?? true 
      },
      { 
        id: 'attendance-alerts', 
        name: 'Attendance Alerts', 
        description: 'Alert parents when student is absent',
        enabled: school?.settings?.notifications?.attendanceAlerts ?? false 
      },
      { 
        id: 'payment-receipts', 
        name: 'Payment Receipts', 
        description: 'Send receipt via SMS/Email after payment',
        enabled: school?.settings?.notifications?.paymentReceipts ?? true 
      }
    ];
    
    res.json({ success: true, notifications });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ message: error.message });
  }
});

// PATCH /api/settings/notifications/:id/toggle - Toggle notification
app.patch('/api/settings/notifications/:id/toggle', authenticate, async (req, res) => {
  try {
    const school = await School.findByPk(req.user.schoolId);
    const settings = school.settings || {};
    const notifications = settings.notifications || {};
    
    // Toggle the specific notification
    notifications[req.params.id] = !notifications[req.params.id];
    
    await school.update({
      settings: { ...settings, notifications }
    });
    
    res.json({ 
      success: true, 
      notification: { 
        id: req.params.id, 
        enabled: notifications[req.params.id] 
      } 
    });
  } catch (error) {
    console.error('Toggle notification error:', error);
    res.status(500).json({ message: error.message });
  }
});
// ADD THESE ROUTES:

// POST /api/backup/create - Create a database backup
app.post('/api/backup/create', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-${req.user.schoolId}-${timestamp}.json`;
    const filepath = path.join(__dirname, 'backups', filename);
    
    // Create backups directory if it doesn't exist
    const backupDir = path.join(__dirname, 'backups');
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    
    // Get all data for this school
    const data = {
      school: await School.findByPk(req.user.schoolId),
      students: await Student.findAll({ where: { schoolId: req.user.schoolId } }),
      staff: await Staff.findAll({ where: { schoolId: req.user.schoolId } }),
      classes: await Class.findAll({ where: { schoolId: req.user.schoolId } }),
      subjects: await Subject.findAll({ where: { schoolId: req.user.schoolId } }),
      exams: await Exam.findAll({ where: { schoolId: req.user.schoolId } }),
      fees: await Fee.findAll({ where: { schoolId: req.user.schoolId } }),
      payments: await Payment.findAll({ where: { schoolId: req.user.schoolId } }),
      timestamp: new Date(),
      version: '1.0'
    };
    
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    
    res.json({ 
      success: true, 
      filename,
      message: 'Backup created successfully'
    });
  } catch (error) {
    console.error('Backup error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET /api/backup/history - Get backup history
app.get('/api/backup/history', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const backupDir = path.join(__dirname, 'backups');
    
    if (!fs.existsSync(backupDir)) {
      return res.json({ success: true, backups: [] });
    }
    
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith(`backup-${req.user.schoolId}`) && f.endsWith('.json'))
      .map(f => {
        const stats = fs.statSync(path.join(backupDir, f));
        return {
          filename: f,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => b.created - a.created);
    
    res.json({ success: true, backups: files });
  } catch (error) {
    console.error('Backup history error:', error);
    res.status(500).json({ message: error.message });
  }
});

// POST /api/backup/restore - Restore from backup
app.post('/api/backup/restore', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const { filename } = req.body;
    const filepath = path.join(__dirname, 'backups', filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ message: 'Backup file not found' });
    }
    
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    
    // Validate that this backup belongs to this school
    if (data.school.id !== req.user.schoolId) {
      return res.status(403).json({ message: 'This backup does not belong to your school' });
    }
    
    // TODO: Implement restore logic (this is complex - requires transactions)
    // For now, just acknowledge
    res.json({ 
      success: true, 
      message: 'Restore functionality requires careful implementation. Please restore manually.' 
    });
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ message: error.message });
  }
});

// GET /api/backup/download/:filename - Download backup
app.get('/api/backup/download/:filename', authenticate, requireSchoolAdmin, async (req, res) => {
  try {
    const filepath = path.join(__dirname, 'backups', req.params.filename);
    
    if (!fs.existsSync(filepath)) {
      return res.status(404).json({ message: 'Backup file not found' });
    }
    
    res.download(filepath);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ message: error.message });
  }
});
// ADD THESE ROUTES:

// GET /api/export/:type - Export data as CSV
app.get('/api/export/:type', authenticate, async (req, res) => {
  try {
    const { type } = req.params;
    const { format = 'csv' } = req.query;
    
    let data = [];
    let filename = `${type}_${new Date().toISOString().split('T')[0]}`;
    
    switch(type) {
      case 'students':
        data = await Student.findAll({ 
          where: { schoolId: req.user.schoolId },
          include: [{ model: Class }]
        });
        filename += '_students.csv';
        break;
      case 'staff':
        data = await Staff.findAll({ 
          where: { schoolId: req.user.schoolId },
          include: [{ model: User }]
        });
        filename += '_staff.csv';
        break;
      case 'fees':
        data = await Fee.findAll({ where: { schoolId: req.user.schoolId } });
        filename += '_fees.csv';
        break;
      case 'payments':
        data = await Payment.findAll({ 
          where: { schoolId: req.user.schoolId },
          include: [{ model: Student }]
        });
        filename += '_payments.csv';
        break;
      case 'results':
        data = await Result.findAll({ 
          include: [
            { model: Student, where: { schoolId: req.user.schoolId } },
            { model: Exam }
          ]
        });
        filename += '_results.csv';
        break;
      case 'attendance':
        data = await Attendance.findAll({ 
          include: [
            { model: Student, where: { schoolId: req.user.schoolId } }
          ]
        });
        filename += '_attendance.csv';
        break;
      default:
        return res.status(400).json({ message: 'Invalid export type' });
    }
    
    // Convert to CSV
    if (data.length === 0) {
      return res.status(404).json({ message: 'No data to export' });
    }
    
    const headers = Object.keys(data[0].toJSON()).join(',');
    const rows = data.map(item => {
      const values = Object.values(item.toJSON()).map(v => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'object') return JSON.stringify(v).replace(/,/g, ';');
        return String(v).replace(/,/g, ';');
      });
      return values.join(',');
    });
    
    const csv = [headers, ...rows].join('\n');
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
    
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== HEALTH RECORDS ENDPOINTS ====================

// GET all health records
app.get('/api/health-records', authenticateToken, async (req, res) => {
  try {
    const { studentId, startDate, endDate, status } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (studentId) where.studentId = studentId;
    if (status) where.status = status;
    if (startDate && endDate) {
      where.date = { [Op.between]: [startDate, endDate] };
    }
    
    const records = await HealthRecords.findAll({
      where,
      include: [
        { 
          model: Student, 
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          required: false 
        }
      ],
      order: [['date', 'DESC']]
    });
    
    res.json({ success: true, records });
  } catch (error) {
    console.error('Error fetching health records:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET single health record
app.get('/api/health-records/:id', authenticateToken, async (req, res) => {
  try {
    const record = await HealthRecords.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      },
      include: [{ model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] }]
    });
    
    if (!record) {
      return res.status(404).json({ success: false, message: 'Health record not found' });
    }
    res.json({ success: true, record });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create health record
app.post('/api/health-records', authenticateToken, async (req, res) => {
  try {
    const { studentId, date, temperature, bloodPressure, weight, height, symptoms, diagnosis, prescription, followUpDate, notes, status } = req.body;
    
    if (!studentId || !date || !diagnosis) {
      return res.status(400).json({ success: false, message: 'Student ID, date, and diagnosis are required' });
    }
    
    const record = await HealthRecords.create({
      studentId,
      date,
      temperature: temperature || null,
      bloodPressure: bloodPressure || null,
      weight: weight || null,
      height: height || null,
      symptoms: symptoms || null,
      diagnosis,
      prescription: prescription || null,
      followUpDate: followUpDate || null,
      notes: notes || null,
      status: status || 'TREATED',
      schoolId: req.user.schoolId,
      recordedBy: req.user.id
    });
    
    res.status(201).json({ success: true, record });
  } catch (error) {
    console.error('Error creating health record:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update health record
app.put('/api/health-records/:id', authenticateToken, async (req, res) => {
  try {
    const record = await HealthRecords.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!record) {
      return res.status(404).json({ success: false, message: 'Health record not found' });
    }
    
    await record.update(req.body);
    res.json({ success: true, record });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE health record
app.delete('/api/health-records/:id', authenticateToken, async (req, res) => {
  try {
    const record = await HealthRecords.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId 
      }
    });
    
    if (!record) {
      return res.status(404).json({ success: false, message: 'Health record not found' });
    }
    
    await record.destroy();
    res.json({ success: true, message: 'Health record deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});


// ==================== SCHEMES OF WORK ENDPOINTS ====================

// GET all schemes of work (with filters for all school types)
app.get('/api/schemes-of-work', authenticate, async (req, res) => {
  try {
    const { 
      classId, subjectId, courseId, unitId, programId, moduleId,
      period, week, covered 
    } = req.query;
    
    const where = { schoolId: req.user.schoolId };
    
    // Regular School filters
    if (classId) where.classId = classId;
    if (subjectId) where.subjectId = subjectId;
    
    // University filters
    if (courseId) where.courseId = courseId;
    if (unitId) where.unitId = unitId;
    
    // TVET filters
    if (programId) where.programId = programId;
    if (moduleId) where.moduleId = moduleId;
    
    if (period) where.period = period;
    if (week) where.week = week;
    if (covered !== undefined) where.covered = covered === 'true';
    
    const include = [];
    
    // Include based on school type (using correct aliases)
    if (classId) include.push({ model: Class, attributes: ['id', 'name'] });
    if (subjectId) include.push({ model: Subject, attributes: ['id', 'name', 'code'] });
    if (courseId) include.push({ model: Course, attributes: ['id', 'name', 'code'] });
    if (unitId) include.push({ model: CourseUnit, as: 'unit', attributes: ['id', 'name', 'code'] });
    if (programId) include.push({ model: Program, attributes: ['id', 'name', 'code'] });
    if (moduleId) include.push({ model: CourseUnit, as: 'tvetModule', attributes: ['id', 'name', 'code'] });
    
    const schemes = await SchemesOfWork.findAll({
      where,
      include,
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, schemes });
  } catch (error) {
    console.error('Error fetching schemes:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create scheme (supports all school types)
app.post('/api/schemes-of-work', authenticate, async (req, res) => {
  try {
    const { 
      classId, subjectId, courseId, unitId, programId, moduleId,
      period, week, topic, subTopic, objectives, teachingActivities,
      learningActivities, resources, assessment, remarks, covered, dateCovered
    } = req.body;
    
    // Validation - at least one identifier must be present
    const hasRegularSchoolId = classId && subjectId;
    const hasUniversityId = courseId && unitId;
    const hasTVETId = programId && moduleId;
    
    if (!hasRegularSchoolId && !hasUniversityId && !hasTVETId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Please provide either (classId + subjectId), (courseId + unitId), or (programId + moduleId)' 
      });
    }
    
    if (!period || !week || !topic) {
      return res.status(400).json({ 
        success: false, 
        message: 'Period, Week, and Topic are required' 
      });
    }
    
    // Verify the references exist based on school type
    const school = await School.findByPk(req.user.schoolId);
    
    if (hasTVETId) {
      // Verify program exists
      const program = await Program.findOne({
        where: { id: programId, schoolId: req.user.schoolId }
      });
      if (!program) {
        return res.status(400).json({ 
          success: false, 
          message: 'Program not found or does not belong to your school' 
        });
      }
      
      // Verify module exists
      const module = await CourseUnit.findOne({
        where: { id: moduleId, programId: programId, schoolId: req.user.schoolId }
      });
      if (!module) {
        return res.status(400).json({ 
          success: false, 
          message: 'Module not found or does not belong to this program' 
        });
      }
    }
    
    // Create the scheme
    const scheme = await SchemesOfWork.create({
      // Regular School fields
      classId: classId || null,
      subjectId: subjectId || null,
      // University fields
      courseId: courseId || null,
      unitId: unitId || null,
      // TVET fields
      programId: programId || null,
      moduleId: moduleId || null,
      // Common fields
      period,
      week,
      topic,
      subTopic: subTopic || null,
      objectives: objectives || null,
      teachingActivities: teachingActivities || null,
      learningActivities: learningActivities || null,
      resources: resources || null,
      assessment: assessment || null,
      remarks: remarks || null,
      covered: covered || false,
      dateCovered: dateCovered || null,
      schoolId: req.user.schoolId,
      createdBy: req.user.id
    });
    
    // Fetch the created scheme with includes
    const include = [];
    if (classId) include.push({ model: Class, attributes: ['id', 'name'] });
    if (subjectId) include.push({ model: Subject, attributes: ['id', 'name', 'code'] });
    if (courseId) include.push({ model: Course, attributes: ['id', 'name', 'code'] });
    if (unitId) include.push({ model: CourseUnit, as: 'unit', attributes: ['id', 'name', 'code'] });
    if (programId) include.push({ model: Program, attributes: ['id', 'name', 'code'] });
    if (moduleId) include.push({ model: CourseUnit, as: 'tvetModule', attributes: ['id', 'name', 'code'] });
    
    const createdScheme = await SchemesOfWork.findByPk(scheme.id, { include });
    
    res.status(201).json({ success: true, scheme: createdScheme });
  } catch (error) {
    console.error('Error creating scheme:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// ==================== SICK BAY ENDPOINTS ====================

// GET sick bay information (room details and current patients)
app.get('/api/sick-bay', authenticateToken, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    
    // Find the sick bay room across all hostels
    const hostels = await Hostel.findAll({
      where: { schoolId },
      attributes: ['id', 'name', 'gender', 'capacity', 'rooms']
    });
    
    let sickBayRoom = null;
    let sickBayHostel = null;
    
    for (const hostel of hostels) {
      const rooms = hostel.rooms || [];
      const room = rooms.find(r => 
        r.roomNumber === 'Sick Bay' || 
        r.name === 'Sick Bay' || 
        r.type === 'SICK_BAY' ||
        r.isSickBay === true
      );
      
      if (room) {
        sickBayRoom = room;
        sickBayHostel = hostel;
        break;
      }
    }
    
    // If no sick bay exists, create default
    if (!sickBayRoom && hostels.length > 0) {
      // Create sick bay in the first hostel
      const defaultHostel = hostels[0];
      const updatedRooms = [...(defaultHostel.rooms || []), {
        roomNumber: 'Sick Bay',
        name: 'Sick Bay',
        beds: 4,
        occupied: 0,
        students: [],
        type: 'SICK_BAY',
        isSickBay: true
      }];
      
      await defaultHostel.update({ rooms: updatedRooms });
      
      sickBayRoom = updatedRooms[updatedRooms.length - 1];
      sickBayHostel = defaultHostel;
    }
    
    // Get current patients (students in sick bay)
    const patients = [];
    if (sickBayRoom && sickBayRoom.students) {
      for (const studentId of sickBayRoom.students) {
        const student = await Student.findOne({
          where: { id: studentId, schoolId },
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber']
        });
        
        if (student) {
          // Get latest health record for this student
          const healthRecord = await HealthRecords.findOne({
            where: { studentId, schoolId },
            order: [['date', 'DESC']]
          });
          
          patients.push({
            id: student.id,
            firstName: student.firstName,
            lastName: student.lastName,
            admissionNumber: student.admissionNumber,
            diagnosis: healthRecord?.diagnosis || 'N/A',
            admittedDate: healthRecord?.date || new Date().toISOString().split('T')[0],
            healthRecordId: healthRecord?.id
          });
        }
      }
    }
    
    res.json({
      success: true,
      sickBay: {
        room: sickBayRoom,
        hostel: sickBayHostel ? { id: sickBayHostel.id, name: sickBayHostel.name } : null,
        patients,
        availableBeds: sickBayRoom ? (sickBayRoom.beds - (sickBayRoom.students?.length || 0)) : 0,
        totalBeds: sickBayRoom?.beds || 0,
        occupied: sickBayRoom?.students?.length || 0
      }
    });
    
  } catch (error) {
    console.error('❌ Get sick bay error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST admit student to sick bay
app.post('/api/sick-bay/admit', authenticateToken, async (req, res) => {
  try {
    const { studentId } = req.body;
    const schoolId = req.user.schoolId;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID is required' });
    }
    
    // Verify student exists and belongs to this school
    const student = await Student.findOne({
      where: { id: studentId, schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    // Find the sick bay room
    const hostels = await Hostel.findAll({
      where: { schoolId },
      attributes: ['id', 'name', 'gender', 'rooms']
    });
    
    let sickBayHostel = null;
    let sickBayRoomIndex = -1;
    
    for (const hostel of hostels) {
      const rooms = hostel.rooms || [];
      const index = rooms.findIndex(r => 
        r.roomNumber === 'Sick Bay' || 
        r.name === 'Sick Bay' || 
        r.type === 'SICK_BAY' ||
        r.isSickBay === true
      );
      
      if (index !== -1) {
        sickBayHostel = hostel;
        sickBayRoomIndex = index;
        break;
      }
    }
    
    if (!sickBayHostel) {
      return res.status(404).json({ 
        success: false, 
        message: 'Sick Bay room not found. Please create a "Sick Bay" room in Hostel Management first.' 
      });
    }
    
    const rooms = sickBayHostel.rooms;
    const room = rooms[sickBayRoomIndex];
    
    // Check if student is already in sick bay
    if (room.students?.includes(studentId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is already in Sick Bay' 
      });
    }
    
    // Check capacity
    if ((room.students?.length || 0) >= room.beds) {
      return res.status(400).json({ 
        success: false, 
        message: `Sick Bay is full (${room.beds} beds capacity)` 
      });
    }
    
    // Add student to room
    const updatedStudents = [...(room.students || []), studentId];
    rooms[sickBayRoomIndex] = {
      ...room,
      students: updatedStudents,
      occupied: updatedStudents.length
    };
    
    await sickBayHostel.update({ rooms });
    
    // Create a health record for admission if not exists
    const existingHealth = await HealthRecords.findOne({
      where: { studentId, schoolId, date: new Date().toISOString().split('T')[0] }
    });
    
    if (!existingHealth) {
      await HealthRecords.create({
        id: crypto.randomUUID(),
        studentId,
        date: new Date().toISOString().split('T')[0],
        diagnosis: 'Admitted to Sick Bay',
        status: 'ADMITTED',
        notes: `Admitted to Sick Bay by ${req.user.firstName} ${req.user.lastName}`,
        schoolId,
        recordedBy: req.user.id
      });
    }
    
    // Create audit log
    await createAuditLog(req, 'ADMIT', 'SICK_BAY', null, null, { studentId, studentName: `${student.firstName} ${student.lastName}` });
    
    res.json({ 
      success: true, 
      message: `${student.firstName} ${student.lastName} admitted to Sick Bay`,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
    
  } catch (error) {
    console.error('❌ Admit to sick bay error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST discharge student from sick bay
app.post('/api/sick-bay/discharge', authenticateToken, async (req, res) => {
  try {
    const { studentId } = req.body;
    const schoolId = req.user.schoolId;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID is required' });
    }
    
    // Verify student exists
    const student = await Student.findOne({
      where: { id: studentId, schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    // Find the sick bay room
    const hostels = await Hostel.findAll({
      where: { schoolId },
      attributes: ['id', 'name', 'gender', 'rooms']
    });
    
    let sickBayHostel = null;
    let sickBayRoomIndex = -1;
    
    for (const hostel of hostels) {
      const rooms = hostel.rooms || [];
      const index = rooms.findIndex(r => 
        r.roomNumber === 'Sick Bay' || 
        r.name === 'Sick Bay' || 
        r.type === 'SICK_BAY' ||
        r.isSickBay === true
      );
      
      if (index !== -1) {
        sickBayHostel = hostel;
        sickBayRoomIndex = index;
        break;
      }
    }
    
    if (!sickBayHostel) {
      return res.status(404).json({ success: false, message: 'Sick Bay room not found' });
    }
    
    const rooms = sickBayHostel.rooms;
    const room = rooms[sickBayRoomIndex];
    
    // Check if student is in sick bay
    if (!room.students?.includes(studentId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is not in Sick Bay' 
      });
    }
    
    // Remove student from room
    const updatedStudents = room.students.filter(id => id !== studentId);
    rooms[sickBayRoomIndex] = {
      ...room,
      students: updatedStudents,
      occupied: updatedStudents.length
    };
    
    await sickBayHostel.update({ rooms });
    
    // Update health record status
    const today = new Date().toISOString().split('T')[0];
    const healthRecord = await HealthRecords.findOne({
      where: { studentId, schoolId, status: 'ADMITTED' },
      order: [['date', 'DESC']]
    });
    
    if (healthRecord) {
      await healthRecord.update({ 
        status: 'DISCHARGED',
        notes: `${healthRecord.notes || ''} Discharged on ${today}`
      });
    }
    
    // Create discharge record
    await HealthRecords.create({
      id: crypto.randomUUID(),
      studentId,
      date: today,
      diagnosis: 'Discharged from Sick Bay',
      status: 'DISCHARGED',
      notes: `Discharged from Sick Bay by ${req.user.firstName} ${req.user.lastName}`,
      schoolId,
      recordedBy: req.user.id
    });
    
    // Create audit log
    await createAuditLog(req, 'DISCHARGE', 'SICK_BAY', null, null, { studentId, studentName: `${student.firstName} ${student.lastName}` });
    
    res.json({ 
      success: true, 
      message: `${student.firstName} ${student.lastName} discharged from Sick Bay`,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
    
  } catch (error) {
    console.error('❌ Discharge from sick bay error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET today's sick students (from attendance)
app.get('/api/sick-bay/today-sick', authenticateToken, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const today = new Date().toISOString().split('T')[0];
    
    const sickAttendance = await Attendance.findAll({
      where: {
        schoolId,
        status: 'SICK',
        date: today
      },
      include: [
        {
          model: Student,
          attributes: ['id', 'firstName', 'lastName', 'admissionNumber'],
          where: { schoolId }
        }
      ]
    });
    
    // Get current sick bay patients to check if already admitted
    const hostels = await Hostel.findAll({
      where: { schoolId },
      attributes: ['rooms']
    });
    
    let sickBayStudentIds = [];
    for (const hostel of hostels) {
      const rooms = hostel.rooms || [];
      for (const room of rooms) {
        if (room.roomNumber === 'Sick Bay' || room.name === 'Sick Bay' || room.type === 'SICK_BAY') {
          sickBayStudentIds = [...sickBayStudentIds, ...(room.students || [])];
        }
      }
    }
    
    const sickStudents = sickAttendance.map(record => ({
      id: record.Student.id,
      firstName: record.Student.firstName,
      lastName: record.Student.lastName,
      admissionNumber: record.Student.admissionNumber,
      recordId: record.id,
      diagnosis: record.remarks || 'Sick',
      isInSickBay: sickBayStudentIds.includes(record.studentId)
    }));
    
    res.json({
      success: true,
      sickStudents,
      count: sickStudents.length
    });
    
  } catch (error) {
    console.error('❌ Get today\'s sick students error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create/initialize sick bay room in a hostel
app.post('/api/sick-bay/initialize', authenticateToken, async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const { hostelId, beds = 4, roomNumber = 'Sick Bay' } = req.body;
    
    // Find the hostel
    let hostel;
    if (hostelId) {
      hostel = await Hostel.findOne({ where: { id: hostelId, schoolId } });
    } else {
      // If no hostel specified, find the first hostel or create one
      hostel = await Hostel.findOne({ where: { schoolId } });
      
      if (!hostel) {
        // Create a default hostel
        hostel = await Hostel.create({
          id: crypto.randomUUID(),
          name: 'Main Hostel',
          gender: 'MIXED',
          capacity: 100,
          schoolId,
          rooms: []
        });
      }
    }
    
    if (!hostel) {
      return res.status(404).json({ success: false, message: 'Hostel not found' });
    }
    
    const rooms = hostel.rooms || [];
    
    // Check if sick bay already exists
    const existingSickBay = rooms.find(r => 
      r.roomNumber === roomNumber || 
      r.name === 'Sick Bay' || 
      r.type === 'SICK_BAY'
    );
    
    if (existingSickBay) {
      return res.status(400).json({ 
        success: false, 
        message: 'Sick Bay already exists in this hostel',
        sickBay: existingSickBay
      });
    }
    
    // Create sick bay room
    const newRoom = {
      roomNumber,
      name: 'Sick Bay',
      beds,
      occupied: 0,
      students: [],
      type: 'SICK_BAY',
      isSickBay: true
    };
    
    rooms.push(newRoom);
    await hostel.update({ rooms });
    
    res.json({
      success: true,
      message: 'Sick Bay created successfully',
      sickBay: newRoom,
      hostel: {
        id: hostel.id,
        name: hostel.name
      }
    });
    
  } catch (error) {
    console.error('❌ Initialize sick bay error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});


// ==================== COURSE ENROLLMENT ROUTES ====================

// GET all course enrollments
app.get('/api/course-enrollments', authenticate, async (req, res) => {
  try {
    const { studentId, courseId, programId, status } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (studentId) where.studentId = studentId;
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;
    if (status) where.status = status;

    const enrollments = await CourseEnrollment.findAll({
      where,
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] },
        { model: User, as: 'approver', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, enrollments });
  } catch (error) {
    console.error('Get course enrollments error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET enrollments for a specific student
app.get('/api/students/:studentId/enrollments', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // Check access
    if (!await checkStudentAccess(studentId, req.user)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const enrollments = await CourseEnrollment.findAll({
      where: { studentId, schoolId: req.user.schoolId },
      include: [
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, enrollments });
  } catch (error) {
    console.error('Get student enrollments error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create course enrollment
app.post('/api/course-enrollments', authenticate, async (req, res) => {
  try {
    const { studentId, courseId, programId, semester, academicYear, status } = req.body;
    
    if (!studentId) {
      return res.status(400).json({ success: false, message: 'Student ID is required' });
    }
    
    if (!courseId && !programId) {
      return res.status(400).json({ success: false, message: 'Either courseId or programId is required' });
    }
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Check if enrollment already exists
    const existing = await CourseEnrollment.findOne({
      where: {
        studentId,
        courseId: courseId || null,
        programId: programId || null,
        status: { [Op.ne]: 'DROPPED' }
      }
    });
    
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is already enrolled in this course/program' 
      });
    }
    
    const enrollment = await CourseEnrollment.create({
      studentId,
      courseId: courseId || null,
      programId: programId || null,
      semester: semester || null,
      academicYear: academicYear || new Date().getFullYear().toString(),
      status: status || (req.user.role === 'SCHOOL_ADMIN' ? 'APPROVED' : 'PENDING'),
      approvedBy: req.user.role === 'SCHOOL_ADMIN' ? req.user.id : null,
      approvedAt: req.user.role === 'SCHOOL_ADMIN' ? new Date() : null,
      schoolId: req.user.schoolId
    });
    
    await createAuditLog(req, 'CREATE', 'COURSE_ENROLLMENT', enrollment.id, null, enrollment);
    
    const createdEnrollment = await CourseEnrollment.findByPk(enrollment.id, {
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ]
    });
    
    res.status(201).json({ success: true, enrollment: createdEnrollment });
  } catch (error) {
    console.error('Create course enrollment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH approve/reject enrollment
app.patch('/api/course-enrollments/:id/approve', authenticate, async (req, res) => {
  try {
    const { action } = req.body; // 'APPROVE' or 'REJECT'
    
    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be APPROVE or REJECT' });
    }
    
    const enrollment = await CourseEnrollment.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId,
        status: 'PENDING'
      }
    });
    
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment not found or already processed' });
    }
    
    const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    
    await enrollment.update({
      status: newStatus,
      approvedBy: req.user.id,
      approvedAt: new Date()
    });
    
    await createAuditLog(req, action, 'COURSE_ENROLLMENT', enrollment.id, null, { newStatus });
    
    res.json({ success: true, enrollment });
  } catch (error) {
    console.error('Approve enrollment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE drop enrollment
app.delete('/api/course-enrollments/:id', authenticate, async (req, res) => {
  try {
    const enrollment = await CourseEnrollment.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!enrollment) {
      return res.status(404).json({ success: false, message: 'Enrollment not found' });
    }
    
    // Check if student is the one dropping
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ where: { userId: req.user.id } });
      if (!student || enrollment.studentId !== student.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }
    
    await enrollment.update({ status: 'DROPPED' });
    
    await createAuditLog(req, 'DROP', 'COURSE_ENROLLMENT', enrollment.id, null, { status: 'DROPPED' });
    
    res.json({ success: true, message: 'Enrollment dropped successfully' });
  } catch (error) {
    console.error('Drop enrollment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET pending enrollments (for admin)
app.get('/api/course-enrollments/pending', authenticate, async (req, res) => {
  try {
    const canApprove = ['SCHOOL_ADMIN', 'PRINCIPAL', 'DEAN', 'HOD'].includes(req.user.role);
    
    if (!canApprove) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const enrollments = await CourseEnrollment.findAll({
      where: { status: 'PENDING', schoolId: req.user.schoolId },
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'ASC']]
    });
    
    res.json({ success: true, enrollments });
  } catch (error) {
    console.error('Get pending enrollments error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== UNIT REGISTRATION ROUTES ====================

// GET all unit registrations
app.get('/api/unit-registrations', authenticate, async (req, res) => {
  try {
    const { studentId, unitId, courseId, programId, status, semester, academicYear } = req.query;
    const where = { schoolId: req.user.schoolId };
    
    if (studentId) where.studentId = studentId;
    if (unitId) where.unitId = unitId;
    if (courseId) where.courseId = courseId;
    if (programId) where.programId = programId;
    if (status) where.status = status;
    if (semester) where.semester = parseInt(semester);
    if (academicYear) where.academicYear = academicYear;

    const registrations = await UnitRegistration.findAll({
      where,
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits', 'semester', 'module'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] },
        { model: User, as: 'approver', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, registrations });
  } catch (error) {
    console.error('Get unit registrations error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET registrations for a specific student
app.get('/api/students/:studentId/unit-registrations', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    // Check access
    if (!await checkStudentAccess(studentId, req.user)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const registrations = await UnitRegistration.findAll({
      where: { studentId, schoolId: req.user.schoolId },
      include: [
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits', 'semester', 'module'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ success: true, registrations });
  } catch (error) {
    console.error('Get student registrations error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST create unit registration
app.post('/api/unit-registrations', authenticate, async (req, res) => {
  try {
    const { studentId, unitId, courseId, programId, semester, academicYear, status } = req.body;
    
    if (!studentId || !unitId) {
      return res.status(400).json({ success: false, message: 'Student ID and Unit ID are required' });
    }
    
    const school = await School.findByPk(req.user.schoolId);
    
    // Check if the student has a valid course/program enrollment
    let enrollment;
    if (courseId) {
      enrollment = await CourseEnrollment.findOne({
        where: { studentId, courseId, status: 'APPROVED' }
      });
    } else if (programId) {
      enrollment = await CourseEnrollment.findOne({
        where: { studentId, programId, status: 'APPROVED' }
      });
    }
    
    if (!enrollment) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is not enrolled in this course/program' 
      });
    }
    
    // Check if already registered for this unit
    const existing = await UnitRegistration.findOne({
      where: {
        studentId,
        unitId,
        status: { [Op.ne]: 'DROPPED' }
      }
    });
    
    if (existing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Student is already registered for this unit' 
      });
    }
    
    // Check payment status if required
    const requiresPayment = school.requiresPaymentForUnits !== false;
    const paymentRequiredPercentage = school.paymentPercentageRequired || 30;
    
    if (requiresPayment) {
      // Calculate fees for this course/program
      let applicableFees = [];
      if (courseId) {
        applicableFees = await Fee.findAll({ where: { courseId, schoolId: req.user.schoolId } });
      } else if (programId) {
        applicableFees = await Fee.findAll({ where: { programId, schoolId: req.user.schoolId } });
      }
      
      const totalFees = applicableFees.reduce((sum, f) => sum + parseFloat(f.amount || 0), 0);
      const payments = await Payment.findAll({ where: { studentId } });
      const totalPaid = payments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
      const paymentPercentage = totalFees > 0 ? (totalPaid / totalFees) * 100 : 100;
      
      if (paymentPercentage < paymentRequiredPercentage) {
        return res.status(400).json({ 
          success: false, 
          message: `You need to pay at least ${paymentRequiredPercentage}% of fees before registering units. Current: ${paymentPercentage.toFixed(1)}%` 
        });
      }
    }
    
    // Determine if auto-approve or require approval
    const requiresApproval = school.unitApprovalRequired !== false;
    
    const registration = await UnitRegistration.create({
      studentId,
      unitId,
      courseId: courseId || null,
      programId: programId || null,
      semester: semester || null,
      academicYear: academicYear || new Date().getFullYear().toString(),
      status: requiresApproval ? 'PENDING' : 'APPROVED',
      approvedBy: !requiresApproval ? req.user.id : null,
      approvedAt: !requiresApproval ? new Date() : null,
      schoolId: req.user.schoolId
    });
    
    await createAuditLog(req, 'CREATE', 'UNIT_REGISTRATION', registration.id, null, registration);
    
    const createdRegistration = await UnitRegistration.findByPk(registration.id, {
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ]
    });
    
    res.status(201).json({ success: true, registration: createdRegistration });
  } catch (error) {
    console.error('Create unit registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH approve/reject unit registration
app.patch('/api/unit-registrations/:id/approve', authenticate, async (req, res) => {
  try {
    const { action } = req.body; // 'APPROVE' or 'REJECT'
    
    if (!action || !['APPROVE', 'REJECT'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action must be APPROVE or REJECT' });
    }
    
    const registration = await UnitRegistration.findOne({
      where: { 
        id: req.params.id,
        schoolId: req.user.schoolId,
        status: 'PENDING'
      }
    });
    
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found or already processed' });
    }
    
    const newStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    
    await registration.update({
      status: newStatus,
      approvedBy: req.user.id,
      approvedAt: new Date()
    });
    
    await createAuditLog(req, action, 'UNIT_REGISTRATION', registration.id, null, { newStatus });
    
    res.json({ success: true, registration });
  } catch (error) {
    console.error('Approve registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE drop unit registration
app.delete('/api/unit-registrations/:id', authenticate, async (req, res) => {
  try {
    const registration = await UnitRegistration.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId }
    });
    
    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration not found' });
    }
    
    // Check if student is the one dropping
    if (req.user.role === 'STUDENT') {
      const student = await Student.findOne({ where: { userId: req.user.id } });
      if (!student || registration.studentId !== student.id) {
        return res.status(403).json({ success: false, message: 'Access denied' });
      }
    }
    
    await registration.update({ status: 'DROPPED' });
    
    await createAuditLog(req, 'DROP', 'UNIT_REGISTRATION', registration.id, null, { status: 'DROPPED' });
    
    res.json({ success: true, message: 'Unit registration dropped successfully' });
  } catch (error) {
    console.error('Drop registration error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET pending unit registrations (for admin)
app.get('/api/unit-registrations/pending', authenticate, async (req, res) => {
  try {
    const canApprove = ['SCHOOL_ADMIN', 'PRINCIPAL', 'DEAN', 'HOD'].includes(req.user.role);
    
    if (!canApprove) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }
    
    const registrations = await UnitRegistration.findAll({
      where: { status: 'PENDING', schoolId: req.user.schoolId },
      include: [
        { model: Student, attributes: ['id', 'firstName', 'lastName', 'admissionNumber'] },
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits'] },
        { model: Course, attributes: ['id', 'name', 'code'] },
        { model: Program, attributes: ['id', 'name', 'code'] }
      ],
      order: [['createdAt', 'ASC']]
    });
    
    res.json({ success: true, registrations });
  } catch (error) {
    console.error('Get pending registrations error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET unit registrations by admission number
app.get('/api/unit-registrations/by-admission/:admissionNumber', authenticate, async (req, res) => {
  try {
    const { admissionNumber } = req.params;
    
    const student = await Student.findOne({
      where: { admissionNumber, schoolId: req.user.schoolId }
    });
    
    if (!student) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    
    const registrations = await UnitRegistration.findAll({
      where: { studentId: student.id, schoolId: req.user.schoolId },
      include: [
        { model: CourseUnit, attributes: ['id', 'name', 'code', 'credits', 'semester', 'module'] }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    res.json({ 
      success: true, 
      registrations,
      student: {
        id: student.id,
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNumber: student.admissionNumber
      }
    });
  } catch (error) {
    console.error('Get registrations by admission error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// GET /api/system/health - Check system health
app.get('/api/system/health', authenticate, async (req, res) => {
  try {
    // Check database connection
    await sequelize.authenticate();
    
    // Check disk space
    const diskSpace = require('check-disk-space').default;
    const freeSpace = await diskSpace('/');
    
    // Check memory usage
    const memory = process.memoryUsage();
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date(),
      uptime: process.uptime(),
      database: 'connected',
      disk: {
        free: freeSpace.free,
        size: freeSpace.size
      },
      memory: {
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB'
      }
    });
  } catch (error) {
    res.json({
      success: true,
      status: 'degraded',
      error: error.message
    });
  }
});
// ==================== SEED FEATURES ROUTE ====================

app.post('/api/seed-features', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const defaultFeatures = [
      { name: 'SMS Notifications', code: 'SMS', category: 'COMMUNICATION', description: 'Send SMS notifications to parents and staff', isEnabled: true },
      { name: 'Email Notifications', code: 'EMAIL', category: 'COMMUNICATION', description: 'Send email notifications', isEnabled: true },
      { name: 'Online Payments', code: 'ONLINE_PAYMENTS', category: 'FINANCE', description: 'Accept online fee payments', isEnabled: false },
      { name: 'Exam Portal', code: 'EXAM_PORTAL', category: 'ACADEMIC', description: 'Online exam submission and grading', isEnabled: false },
      { name: 'Parent Portal', code: 'PARENT_PORTAL', category: 'ACCESS', description: 'Parent login to view student progress', isEnabled: true },
      { name: 'Student Portal', code: 'STUDENT_PORTAL', category: 'ACCESS', description: 'Student login to view results', isEnabled: true },
      { name: 'Library Management', code: 'LIBRARY', category: 'RESOURCES', description: 'Complete library management system', isEnabled: true },
      { name: 'Transport Tracking', code: 'TRANSPORT', category: 'LOGISTICS', description: 'Real-time vehicle tracking', isEnabled: false },
      { name: 'Hostel Management', code: 'HOSTEL', category: 'ACCOMMODATION', description: 'Hostel room allocation and management', isEnabled: false },
      { name: 'Inventory Management', code: 'INVENTORY', category: 'RESOURCES', description: 'Stock and inventory tracking', isEnabled: true },
      { name: 'Attendance Biometrics', code: 'BIOMETRICS', category: 'ATTENDANCE', description: 'Biometric attendance marking', isEnabled: false },
      { name: 'WhatsApp Integration', code: 'WHATSAPP', category: 'COMMUNICATION', description: 'Send WhatsApp messages', isEnabled: false }
    ];

    const schoolId = req.user.schoolId || req.body.schoolId;
    
    if (!schoolId) {
      return res.status(400).json({ message: 'School ID is required' });
    }

    const created = [];
    for (const feature of defaultFeatures) {
      const [featureInstance, created_] = await Feature.findOrCreate({
        where: { code: feature.code, schoolId },
        defaults: { ...feature, schoolId }
      });
      if (created_) created.push(featureInstance);
    }

    res.json({ 
      success: true, 
      message: `Created ${created.length} new features`,
      features: created
    });
  } catch (error) {
    console.error('Seed features error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== SEED FEATURES FOR ALL SCHOOLS ====================
app.post('/api/seed-features/all-schools', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const defaultFeatures = [
      { name: 'SMS Notifications', code: 'SMS', category: 'COMMUNICATION', description: 'Send SMS notifications to parents and staff', isEnabled: true },
      { name: 'Email Notifications', code: 'EMAIL', category: 'COMMUNICATION', description: 'Send email notifications', isEnabled: true },
      { name: 'Online Payments', code: 'ONLINE_PAYMENTS', category: 'FINANCE', description: 'Accept online fee payments', isEnabled: false },
      { name: 'Exam Portal', code: 'EXAM_PORTAL', category: 'ACADEMIC', description: 'Online exam submission and grading', isEnabled: false },
      { name: 'Parent Portal', code: 'PARENT_PORTAL', category: 'ACCESS', description: 'Parent login to view student progress', isEnabled: true },
      { name: 'Student Portal', code: 'STUDENT_PORTAL', category: 'ACCESS', description: 'Student login to view results', isEnabled: true },
      { name: 'Library Management', code: 'LIBRARY', category: 'RESOURCES', description: 'Complete library management system', isEnabled: true },
      { name: 'Transport Tracking', code: 'TRANSPORT', category: 'LOGISTICS', description: 'Real-time vehicle tracking', isEnabled: false },
      { name: 'Hostel Management', code: 'HOSTEL', category: 'ACCOMMODATION', description: 'Hostel room allocation and management', isEnabled: true },
      { name: 'Inventory Management', code: 'INVENTORY', category: 'RESOURCES', description: 'Stock and inventory tracking', isEnabled: true },
      { name: 'Attendance Biometrics', code: 'BIOMETRICS', category: 'ATTENDANCE', description: 'Biometric attendance marking', isEnabled: false },
      { name: 'WhatsApp Integration', code: 'WHATSAPP', category: 'COMMUNICATION', description: 'Send WhatsApp messages', isEnabled: false }
    ];

    // Get all schools
    const schools = await School.findAll();
    
    if (!schools || schools.length === 0) {
      return res.status(404).json({ message: 'No schools found' });
    }

    const results = {
      totalSchools: schools.length,
      schoolsProcessed: 0,
      totalFeaturesCreated: 0,
      details: []
    };

    // For each school, create features
    for (const school of schools) {
      const schoolId = school.id;
      let featuresCreated = 0;
      
      for (const feature of defaultFeatures) {
        const [featureInstance, created] = await Feature.findOrCreate({
          where: { code: feature.code, schoolId },
          defaults: { ...feature, schoolId }
        });
        if (created) featuresCreated++;
      }
      
      results.schoolsProcessed++;
      results.totalFeaturesCreated += featuresCreated;
      results.details.push({
        schoolId: school.id,
        schoolName: school.name,
        featuresCreated
      });
    }

    res.json({ 
      success: true, 
      message: `Seeded features for ${results.schoolsProcessed} schools. Created ${results.totalFeaturesCreated} total features.`,
      results
    });
  } catch (error) {
    console.error('Seed all schools error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ==================== ERROR HANDLER ====================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;

sequelize.sync({ alter: true })
  .then(() => {
    console.log('✅ Database synced successfully');
    console.log('📊 Grading Systems Loaded:');
    console.log('   - CBC (ECDE & Primary)');
    console.log('   - 8-4-4 (Secondary)');
    console.log('   - TVET (Competency Based)');
    console.log('   - University (GPA Based)');
    console.log('   - IB (International Baccalaureate)');
    console.log('   - Cambridge IGCSE');
    console.log('   - American System');
    app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      console.log(`📚 API Documentation: http://localhost:${PORT}/api`);
      console.log(`✅ All routes are now fixed!`);
      console.log(`   - Students: http://localhost:${PORT}/api/students`);
      console.log(`   - Exams: http://localhost:${PORT}/api/exams`);
      console.log(`   - Fees: http://localhost:${PORT}/api/fees`);
      console.log(`   - Timetable: http://localhost:${PORT}/api/timetable`);
    });
  })
  .catch(err => {
    console.error('❌ Database sync error:', err);
  });